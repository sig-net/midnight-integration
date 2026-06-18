/**
 * ERC20 Vault E2E Test
 *
 * Tests the full vault flow on Midnight standalone devnet:
 *   deploy → initialize → deposit → claim (Schnorr + outputData) → verify balance
 *
 * Security model: the contract stores individual typed parameters and a
 * dynamic calldata arg array. The MPC reads these, builds the ABI calldata
 * + RLP tx off-chain, signs the result with Schnorr, and broadcasts via
 * WebSocket. The user calls claim() with the MPC's signature + outputData.
 *
 * The test uses a SINGLE wallet for both user and MPC roles. This is valid
 * because the contract logic is the same regardless of who holds the keys.
 *
 * Prerequisites:
 *   - Midnight standalone docker compose running (npm run standalone in contract-cli)
 *   - OR: set RUN_ENV_TESTS=true with TEST_WALLET_SEED + TEST_ENV for testnet
 */

import { convertFieldToBytes } from '@midnight-ntwrk/compact-runtime';
import { unshieldedToken, shieldedToken, rawTokenType } from '@midnight-ntwrk/ledger-v8';
import path from 'path';
import * as api from '../api';
import { type WalletContext } from '../api';
import { type VaultPrivateState, type VaultProviders } from '../common-types';
import { currentDir, StandaloneConfig } from '../config';
import { createLogger } from '../logger-utils';
import { hash2x32, pad32, padN, GENESIS_MINT_WALLET_SEED } from '../crypto-utils';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Rx from 'rxjs';
import { deriveJubjubKeypair, schnorrSign, buildSignetMessage } from '../signet/schnorr';
import { encodeString, encodeLengthPrefixed, bytesToBigint } from '../signet';
import {
  CAIP2_ID_SIZE,
  PATH_SIZE,
  ALGO_SIZE,
  DEST_SIZE,
  PARAMS_SIZE,
  OUTPUT_SCHEMA_SIZE,
  RESPOND_SCHEMA_SIZE,
  OUTPUT_DATA_SIZE,
} from '../signet/constants';
import { computeRequestId, calldataArgKey, computeCalldataArgsCommitment } from '../signet/request-id';

const logDir = path.resolve(currentDir, '..', 'logs', 'tests', `vault-${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);


describe('ERC20 Vault', () => {
  let walletCtx: WalletContext;
  let providers: VaultProviders;
  let deployedContract: any;
  let contractAddress: string;

  const config = new StandaloneConfig();

  // Test-only MPC Jubjub keypair. Self-contained — not the real MPC's key.
  // The deploy script (deploy-for-e2e.ts) uses the real MPC public key instead.
  const jubjubSk = 4018676151312069165193976310227756429900464361256491869742201481284330741328n;
  const jubjubPk = {
    x: 46187818232161622888334427924906639536457939789643067940921057143361865067509n,
    y: 5636111859857507140070071300015721063909078565431757593796728049156534815522n,
  };

  // User secret key — stored in the wallet's private state.
  // In production, derived from the user's HD wallet seed.
  const secretKey = hash2x32(pad32('test:user:'), pad32('vault-api-test'));
  const userIdentityCommitment = hash2x32(pad32('vault:user:'), secretKey);

  // Sepolia USDC contract address
  const testErc20Address = Buffer.from('1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'hex');
  const testAmount = 1_000_000n; // 1 USDC (6 decimals)
  const testEvmChainId = 11155111n; // Sepolia
  const testEvmNonce = 0n;
  const testEvmGasLimit = 100_000n;
  const testEvmMaxFee = 30_000_000_000n; // 30 gwei
  const testEvmPriorityFee = 1_000_000_000n; // 1 gwei
  const testEvmValue = 0n;

  // Test vault address — deterministic from contract address, no real derivation needed.
  const testSepoliaVault = hash2x32(pad32('test:vault:'), pad32('api-test')).slice(0, 20);

  // Signet routing fields
  const testCaip2Id = encodeString('eip155:11155111', CAIP2_ID_SIZE);
  const testKeyVersion = 0n;
  const testPath = new Uint8Array(PATH_SIZE);
  testPath.set(userIdentityCommitment, 0);
  const testAlgo = encodeString('ecdsa', ALGO_SIZE);
  const testDest = encodeString('ethereum', DEST_SIZE);
  const testParams = encodeLengthPrefixed(new Uint8Array(0), PARAMS_SIZE);
  const testOutputSchema = encodeString('[{"name":"success","type":"bool"}]', OUTPUT_SCHEMA_SIZE);
  const testRespondSchema = encodeString('[{"name":"success","type":"bool"}]', RESPOND_SCHEMA_SIZE);

  // Will be set after deposit
  let requestId: Uint8Array;

  beforeAll(
    async () => {
      api.setLogger(logger);

      // Build wallet from genesis seed and wait for funds
      logger.info('Building wallet from genesis seed...');
      walletCtx = await api.buildWalletAndWaitForFunds(config, GENESIS_MINT_WALLET_SEED);

      const state = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
      const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
      logger.info(`Wallet address: ${walletCtx.unshieldedKeystore.getBech32Address()}`);
      logger.info(`Wallet balance: ${balance}`);
      expect(balance).toBeGreaterThan(0n);

      // Shield some tDUST so the ShieldedWallet has coins for Zswap
      // balancing when claim() mints a shielded token.
      const shieldedBalance = state.shielded.balances[unshieldedToken().raw] ?? 0n;
      if (shieldedBalance === 0n) {
        logger.info('Shielding tDUST for Zswap balancing...');
        const shieldAmount = 10_000_000_000_000n; // 10T (from 250T unshielded)
        const shieldedAddr = state.shielded.address;
        const recipe = await walletCtx.wallet.transferTransaction(
          [{ type: 'shielded', outputs: [{ type: unshieldedToken().raw, receiverAddress: shieldedAddr, amount: shieldAmount }] }],
          { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
          { ttl: new Date(Date.now() + 30 * 60 * 1000) },
        );
        const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signData(payload);
        const signed = await walletCtx.wallet.signRecipe(recipe, signFn);
        const finalizedTx = await walletCtx.wallet.finalizeRecipe(signed);
        await walletCtx.wallet.submitTransaction(finalizedTx);

        // Wait for shielded balance to appear
        await Rx.firstValueFrom(
          walletCtx.wallet.state().pipe(
            Rx.throttleTime(5_000),
            Rx.filter((s) => s.isSynced && (s.shielded.balances[unshieldedToken().raw] ?? 0n) > 0n),
          ),
        );
        const newState = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
        logger.info(`Shielded tDUST balance: ${newState.shielded.balances[unshieldedToken().raw] ?? 0n}`);
      } else {
        logger.info(`Shielded tDUST already available: ${shieldedBalance}`);
      }

      // Configure providers
      providers = await api.configureProviders(walletCtx, config);
    },
    1000 * 60 * 10, // 10 min for wallet sync
  );

  afterAll(async () => {
    if (walletCtx?.wallet) {
      await walletCtx.wallet.stop();
    }
  });

  it('should deploy the vault contract', async () => {
    const privateState: VaultPrivateState = { secretKey };
    deployedContract = await api.deploy(providers, privateState, jubjubPk, userIdentityCommitment);

    expect(deployedContract).not.toBeNull();
    contractAddress = deployedContract.deployTxData.public.contractAddress;
    expect(contractAddress).toBeDefined();
    logger.info(`Vault deployed at: ${contractAddress}`);

    // MPC key is sealed at deploy
    const ledger = await api.getLedgerState(providers, contractAddress);
    expect(ledger!.mpcPubKeyHash).toBeDefined();
    expect(ledger!.mpcPubKeyHash.length).toBe(32);
  });

  it('should initialize the vault address', async () => {
    const result = await deployedContract.callTx.initialize(testSepoliaVault);
    expect(result.public.txHash).toMatch(/[0-9a-f]{64}/);
    logger.info(`initialize() confirmed: ${result.public.txHash}`);

    const ledger = await api.getLedgerState(providers, contractAddress);
    expect(ledger).not.toBeNull();
    expect(ledger!.initialized).toBe(1n);
    expect(Buffer.from(ledger!.sepoliaVaultAddress)).toEqual(Buffer.from(testSepoliaVault));
  });

  it('should accept a deposit with calldata + gas params', async () => {
    const result = await deployedContract.callTx.deposit(
      testErc20Address,
      testAmount,
      testEvmChainId,
      testEvmNonce,
      testEvmGasLimit,
      testEvmMaxFee,
      testEvmPriorityFee,
      testEvmValue,
      testCaip2Id,
      testKeyVersion,
      testPath,
      testAlgo,
      testDest,
      testParams,
      testOutputSchema,
      testRespondSchema,
    );
    expect(result.public.txHash).toMatch(/[0-9a-f]{64}/);
    logger.info(`deposit() confirmed: ${result.public.txHash}`);

    // Verify ledger state
    const ledger = await api.getLedgerState(providers, contractAddress);
    expect(ledger).not.toBeNull();
    expect(ledger!.signetNonce).toBe(1n);
    expect(ledger!.signetRequestNonce.isEmpty()).toBe(false);

    // Extract the requestId from signet standard maps
    const entries = [...ledger!.signetRequestNonce];
    expect(entries.length).toBe(1);
    requestId = entries[0][0];

    logger.info(`Request ID: ${Buffer.from(requestId).toString('hex')}`);

    // Verify signet standard maps are populated
    expect(ledger!.signetCalldataFuncSig.member(requestId)).toBe(true);
    expect(ledger!.signetCalldataArgCount.lookup(requestId)).toBe(2n);
    expect(ledger!.signetEvmTo.member(requestId)).toBe(true);
    expect(ledger!.signetEvmChainId.lookup(requestId)).toBe(testEvmChainId);
    expect(ledger!.signetEvmNonce.lookup(requestId)).toBe(testEvmNonce);
    expect(ledger!.signetEvmGasLimit.lookup(requestId)).toBe(testEvmGasLimit);
    expect(ledger!.signetEvmMaxFee.lookup(requestId)).toBe(testEvmMaxFee);
    expect(ledger!.signetEvmPriorityFee.lookup(requestId)).toBe(testEvmPriorityFee);
    expect(ledger!.signetEvmValue.lookup(requestId)).toBe(testEvmValue);

    // Verify compound-keyed calldata args
    const argKey0 = calldataArgKey(requestId, 0);
    const argKey1 = calldataArgKey(requestId, 1);
    expect(ledger!.signetCalldataArgs.member(argKey0)).toBe(true);
    expect(ledger!.signetCalldataArgs.member(argKey1)).toBe(true);

    // signetPath stores the commitment (user's "address" as Field as Bytes<256>)
    expect(ledger!.signetPath.member(requestId)).toBe(true);
  });

  it('should allow the depositor to claim with Schnorr-authenticated outputData', async () => {
    // Simulate MPC: sign (requestId, outputData) with the Jubjub private key
    // outputData = ABI-encoded true (uint256 = 1, big-endian in first 32 bytes)
    const outputData = new Uint8Array(OUTPUT_DATA_SIZE);
    outputData[0] = 1; // LE-encoded true: Compact's Bytes<32> as Field interprets little-endian
    const sig = schnorrSign(jubjubSk, buildSignetMessage(requestId, outputData), api.schnorrChallenge);

    // User calls claim() with the MPC's signature + outputData
    const result = await deployedContract.callTx.claim(
      requestId,
      outputData,
      jubjubPk,
      sig.announcement,
      sig.response,
    );
    expect(result.public.txHash).toMatch(/[0-9a-f]{64}/);
    logger.info(`claim() confirmed: ${result.public.txHash}`);

    // Verify cleanup: all signet maps removed
    const ledger = await api.getLedgerState(providers, contractAddress);
    expect(ledger).not.toBeNull();
    expect(ledger!.signetRequestNonce.isEmpty()).toBe(true);
    expect(ledger!.signetCalldataFuncSig.isEmpty()).toBe(true);
    expect(ledger!.signetCalldataArgCount.isEmpty()).toBe(true);
    expect(ledger!.signetCalldataArgs.isEmpty()).toBe(true);
    expect(ledger!.signetEvmTo.isEmpty()).toBe(true);
    expect(ledger!.signetEvmChainId.isEmpty()).toBe(true);
    expect(ledger!.signetEvmNonce.isEmpty()).toBe(true);
    expect(ledger!.signetEvmGasLimit.isEmpty()).toBe(true);
    expect(ledger!.signetEvmMaxFee.isEmpty()).toBe(true);
    expect(ledger!.signetEvmPriorityFee.isEmpty()).toBe(true);
    expect(ledger!.signetEvmValue.isEmpty()).toBe(true);

    // Verify outputData stored for auditability
    expect(ledger!.signetOutputData.member(requestId)).toBe(true);

    // Verify minted UTXO token in wallet
    const erc20AsBigint = bytesToBigint(testErc20Address);
    const erc20As32 = convertFieldToBytes(32, erc20AsBigint, 'test:erc20');
    const domainSep = hash2x32(pad32('erc20:vault:'), erc20As32);
    const expectedTokenType = rawTokenType(domainSep, contractAddress);
    const walletState = await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
    );
    const tokenBalance = walletState.shielded.balances[expectedTokenType] ?? 0n;
    expect(tokenBalance).toBe(testAmount);

    logger.info(`Shielded token balance: ${tokenBalance} (type: ${expectedTokenType})`);
  });

  it('should handle a second deposit + claim cycle', async () => {
    const secondAmount = 2_000_000n;

    const depositResult = await deployedContract.callTx.deposit(
      testErc20Address,
      secondAmount,
      testEvmChainId,
      testEvmNonce + 1n,
      testEvmGasLimit,
      testEvmMaxFee,
      testEvmPriorityFee,
      testEvmValue,
      testCaip2Id,
      testKeyVersion,
      testPath,
      testAlgo,
      testDest,
      testParams,
      testOutputSchema,
      testRespondSchema,
    );
    expect(depositResult.public.txHash).toMatch(/[0-9a-f]{64}/);

    const ledger = await api.getLedgerState(providers, contractAddress);
    expect(ledger!.signetNonce).toBe(2n);

    // Get the new request ID from signet standard maps
    const entries = [...ledger!.signetRequestNonce];
    const newRequestId = entries[0][0];

    // Claim with Schnorr-signed outputData (simulating MPC broadcast)
    const outputData = new Uint8Array(OUTPUT_DATA_SIZE);
    outputData[0] = 1; // LE-encoded true
    const sig = schnorrSign(jubjubSk, buildSignetMessage(newRequestId, outputData), api.schnorrChallenge);
    await deployedContract.callTx.claim(
      newRequestId, outputData, jubjubPk, sig.announcement, sig.response,
    );

    // Wallet should hold cumulative balance for the same token type
    const erc20AsBigint = bytesToBigint(testErc20Address);
    const erc20As32 = convertFieldToBytes(32, erc20AsBigint, 'test:erc20');
    const domainSep = hash2x32(pad32('erc20:vault:'), erc20As32);
    const expectedTokenType = rawTokenType(domainSep, contractAddress);
    const walletState = await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
    );
    const tokenBalance = walletState.shielded.balances[expectedTokenType] ?? 0n;
    expect(tokenBalance).toBe(testAmount + secondAmount);

    logger.info(`Cumulative shielded balance: ${tokenBalance}`);
  });
});

