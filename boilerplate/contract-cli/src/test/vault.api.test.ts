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
import { type VaultPrivateState, type VaultProviders, VaultPrivateStateId } from '../common-types';
import { currentDir, StandaloneConfig } from '../config';
import { createLogger } from '../logger-utils';
import { hash2x32, pad32, padN, GENESIS_MINT_WALLET_SEED } from '../crypto-utils';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
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
  // Path = lowercase hex of the identity commitment (ASCII), zero-padded. The
  // contract verifies this hex decodes to the commitment.
  const commitmentHex = Buffer.from(userIdentityCommitment).toString('hex');
  const testPath = new Uint8Array(PATH_SIZE);
  new TextEncoder().encodeInto(commitmentHex, testPath);
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

  // Restart the proof server before each test so every test gets a fresh prover.
  // On 16 GB hardware the heavy deposit/claim proofs (150 MB+ keys) accumulate and
  // OOM the prover after ~4; a per-test restart keeps each within budget. Uses
  // `restart` (not down/up) so the cached k=17 setup params reload from disk.
  beforeEach(() => {
    try {
      execSync('docker compose -f standalone.yml restart proof-server', { stdio: 'ignore', timeout: 60000 });
      for (let i = 0; i < 60; i++) {
        try { execSync('curl -sf -o /dev/null http://127.0.0.1:6300', { stdio: 'ignore' }); return; }
        catch { execSync('sleep 1', { stdio: 'ignore' }); }
      }
    } catch { /* best-effort; if docker isn't reachable the test will surface it */ }
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

    // outputData is intentionally NOT persisted on-chain anymore (removed to
    // avoid permanent 4KB-per-claim ledger bloat).
    expect(ledger!.signetOutputData.member(requestId)).toBe(false);

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

  // ── Withdraw flow (balance-based) ───────────────────────────────────────
  // withdraw() surrenders `amount` of the caller's shielded vault-token balance.
  // The coin is a circuit PARAMETER: the wallet funds its value from balance and
  // makes change; its nonce is arbitrary (the contract's received-coin nonce), and
  // its color/value are enforced on-chain. On EVM failure (0xdeadbeef)
  // completeWithdraw() re-mints to refundPk. These reuse the ~3M vault-token
  // balance minted by the deposit/claim cycles above — no fresh deposits, fewer
  // proofs, and exactly how the protocol draws from balance.
  // Vault-token color = rawTokenType(hash("erc20:vault:", erc20Address), contractAddress).
  // Parametrised by erc20Address so an attack test can build a coin for a DIFFERENT
  // (worthless) ERC20 and prove withdraw rejects it.
  const vaultColorHexFor = (erc20: Uint8Array): string =>
    rawTokenType(hash2x32(pad32('erc20:vault:'), convertFieldToBytes(32, bytesToBigint(erc20), 'erc20')), contractAddress);
  const vaultColorHex = (): string => vaultColorHexFor(testErc20Address);
  const vaultColorBytes = (): Uint8Array => new Uint8Array(Buffer.from(vaultColorHex(), 'hex'));
  const shieldedBalance = async (): Promise<bigint> => {
    const s = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((x) => x.isSynced)));
    return s.shielded.balances[vaultColorHex()] ?? 0n;
  };
  let nonceCtr = 0;
  // Arbitrary but unique per-call nonce (the contract's received-coin nonce).
  const mkNonce = (): Uint8Array => new Uint8Array(32).fill((nonceCtr++ % 250) + 1);
  // Full coin struct (nonce, color, value) for the withdraw circuit parameter.
  const mkCoin = (value: bigint, color: Uint8Array = vaultColorBytes()) =>
    ({ nonce: mkNonce(), color, value });
  let evmCtr = 20n;
  const nextEvmNonce = (): bigint => testEvmNonce + (evmCtr++);
  const myRefundPk = async (): Promise<{ bytes: Uint8Array }> => {
    const s = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((x) => x.isSynced)));
    return { bytes: new Uint8Array(Buffer.from(s.shielded.coinPublicKey.toHexString().replace(/^0x/, ''), 'hex')) };
  };
  const doWithdraw = (amount: bigint, refundPk: { bytes: Uint8Array }, coin = mkCoin(amount)) =>
    deployedContract.callTx.withdraw(
      testErc20Address, amount, coin, testErc20Address, refundPk, testEvmChainId, nextEvmNonce(),
      testEvmGasLimit, testEvmMaxFee, testEvmPriorityFee, testEvmValue, testCaip2Id,
      testKeyVersion, testAlgo, testDest, testParams, testOutputSchema, testRespondSchema,
    );
  const pendingRidHexes = async (): Promise<string[]> => {
    const led = await api.getLedgerState(providers, contractAddress);
    return [...led!.refundRecipient].map(([k]) => Buffer.from(k).toString('hex'));
  };
  const withdrawAndRid = async (amount: bigint, refundPk: { bytes: Uint8Array }): Promise<Uint8Array> => {
    const before = new Set(await pendingRidHexes());
    await doWithdraw(amount, refundPk);
    const newHex = (await pendingRidHexes()).find((h) => !before.has(h))!;
    return new Uint8Array(Buffer.from(newHex, 'hex'));
  };
  const completeWith = (rid: Uint8Array, firstBytes: number[]) => {
    const out = new Uint8Array(OUTPUT_DATA_SIZE); out.set(firstBytes, 0);
    const sig = schnorrSign(jubjubSk, buildSignetMessage(rid, out), api.schnorrChallenge);
    return deployedContract.callTx.completeWithdraw(rid, out, jubjubPk, sig.announcement, sig.response);
  };

  // #1/#2 — withdraw draws from balance; deadbeef refund restores it (to self).
  it('withdraws from balance, then refunds the value on a deadbeef failure', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    expect(bal).toBeGreaterThanOrEqual(W);
    const rid = await withdrawAndRid(W, await myRefundPk());
    expect(await shieldedBalance()).toBe(bal - W);           // value surrendered
    const led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundRecipient.member(rid)).toBe(true);
    await completeWith(rid, [0xde, 0xad, 0xbe, 0xef]);       // failure → refund
    expect(await shieldedBalance()).toBe(bal);              // restored
    const led2 = await api.getLedgerState(providers, contractAddress);
    expect(led2!.refundRecipient.member(rid)).toBe(false);  // cleaned up
  });


  // #5 — success completion is final: no refund.
  it('completeWithdraw with a success output is final (no refund)', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    const rid = await withdrawAndRid(W, await myRefundPk());
    expect(await shieldedBalance()).toBe(bal - W);
    await completeWith(rid, [1]); // EVM success
    expect(await shieldedBalance()).toBe(bal - W);           // NOT refunded
    const led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundRecipient.member(rid)).toBe(false);
  });

  // #6 — a deadbeef failure refunds to the CALLER-CHOSEN refundPk, which can be a
  // DIFFERENT wallet than the withdrawer. Build a second wallet B, name B's key as the
  // refund recipient, fail the withdraw, and assert the refund coin is actually MINTED to
  // B (B's vault-token balance rises by W) while A is NOT restored. Minting a shielded
  // coin to B needs B's encryption public key, supplied via the resolver mapping.
  it('refunds to a second wallet (the caller-chosen refundPk), not the caller', async () => {
    const W = 200_000n;
    const balA = await shieldedBalance();

    // B only RECEIVES the minted refund (passive — no funding needed to observe a coin).
    const bCtx = await api.buildWallet(config, Buffer.from(api.randomBytes(32)).toString('hex'));
    try {
      const bState: any = await Rx.firstValueFrom(bCtx.wallet.state().pipe(Rx.filter((x: any) => x.isSynced)));
      const bCoinPkHex: string = bState.shielded.coinPublicKey.toHexString();
      const bEncPkHex: string = bState.shielded.encryptionPublicKey.toHexString();
      const bCoinPkBare = bCoinPkHex.replace(/^0x/, '');
      const bRefundPk = { bytes: new Uint8Array(Buffer.from(bCoinPkBare, 'hex')) };
      const balBbefore = bState.shielded.balances[vaultColorHex()] ?? 0n;

      // A withdraws, naming B as the refund recipient.
      const rid = await withdrawAndRid(W, bRefundPk);
      expect(await shieldedBalance()).toBe(balA - W);                       // A surrendered the coin
      const led = await api.getLedgerState(providers, contractAddress);
      expect(Buffer.from(led!.refundRecipient.lookup(rid)).toString('hex')).toBe(bCoinPkBare); // stored = B

      // Deadbeef failure → refund mints to B (supply B's enc pk so the output can be built).
      const out = new Uint8Array(OUTPUT_DATA_SIZE); out.set([0xde, 0xad, 0xbe, 0xef], 0);
      const sig = schnorrSign(jubjubSk, buildSignetMessage(rid, out), api.schnorrChallenge);
      await api.completeWithdrawWithMappings(
        providers, contractAddress,
        [rid, out, jubjubPk, sig.announcement, sig.response],
        new Map([[bCoinPkHex, bEncPkHex]]),
      );

      expect(await shieldedBalance()).toBe(balA - W);                      // A NOT refunded
      const balBafter: bigint = await Rx.firstValueFrom(
        bCtx.wallet.state().pipe(
          Rx.throttleTime(3000),
          Rx.filter((x: any) => x.isSynced && (x.shielded.balances[vaultColorHex()] ?? 0n) > balBbefore),
          Rx.map((x: any) => x.shielded.balances[vaultColorHex()] ?? 0n),
        ),
      );
      expect(balBafter).toBe(balBbefore + W);                             // B received the refund
      const led2 = await api.getLedgerState(providers, contractAddress);
      expect(led2!.refundRecipient.member(rid)).toBe(false);              // cleaned up
    } finally {
      await bCtx.wallet.stop();
    }
  });

  // W3 — a forged / wrong-key MPC signature on completeWithdraw must be rejected.
  // This is the dangerous path: a refund MINTS vault tokens, so if the Schnorr
  // signature were forgeable an attacker could mint at will. The contract verifies
  // (rid, hash(outputData)) against the registered MPC key, so a tampered response
  // scalar or a swapped pk fails IN-CIRCUIT → the proof can't be produced and nothing
  // is minted. Verified from the outside: balance unchanged + withdrawal still pending.
  it('rejects completeWithdraw with a forged or wrong-key MPC signature (no refund minted)', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    const rid = await withdrawAndRid(W, await myRefundPk());
    expect(await shieldedBalance()).toBe(bal - W);           // coin surrendered

    const out = new Uint8Array(OUTPUT_DATA_SIZE); out.set([0xde, 0xad, 0xbe, 0xef], 0);
    const sig = schnorrSign(jubjubSk, buildSignetMessage(rid, out), api.schnorrChallenge);

    // (a) Real key + signature, but flip one bit of the response scalar → s·G ≠ R + h·pk.
    await expect(
      deployedContract.callTx.completeWithdraw(rid, out, jubjubPk, sig.announcement, sig.response ^ 1n),
    ).rejects.toThrow();
    expect(await shieldedBalance()).toBe(bal - W);           // NO refund minted
    let led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundRecipient.member(rid)).toBe(true);     // still pending

    // (b) Real signature, but a different public key → pk hash ≠ stored mpcPubKeyHash.
    await expect(
      deployedContract.callTx.completeWithdraw(
        rid, out, { x: jubjubPk.x + 1n, y: jubjubPk.y }, sig.announcement, sig.response),
    ).rejects.toThrow('Unauthorized: wrong public key');
    expect(await shieldedBalance()).toBe(bal - W);           // still no mint
    led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundRecipient.member(rid)).toBe(true);     // still pending

    // The legitimate MPC signature DOES complete it → refund restores the balance.
    await completeWith(rid, [0xde, 0xad, 0xbe, 0xef]);
    expect(await shieldedBalance()).toBe(bal);               // restored only by the real key
    led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundRecipient.member(rid)).toBe(false);    // now cleaned up
  });

  // #8 (drain attack) — surrendering a coin of the WRONG color must be rejected.
  // The coin is a caller-supplied parameter, so a malicious caller could try to pull
  // the real ERC20 by surrendering a worthless vault token (one minted for a DIFFERENT,
  // worthless ERC20). withdraw derives the expected color from the requested erc20Address
  // (assert coin.color == tokenType(hash("erc20:vault:", erc20Address), self)), so the
  // mismatch fails a GUARANTEED assert → the whole tx is rejected and no coin is taken.
  it('rejects a withdraw whose surrendered coin is the wrong vault-token color (drain attack)', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    const worthlessErc20 = new Uint8Array(20).fill(0xab); // a different (worthless) ERC20
    const wrongColor = new Uint8Array(Buffer.from(vaultColorHexFor(worthlessErc20), 'hex'));
    expect(Buffer.compare(wrongColor, vaultColorBytes())).not.toBe(0); // sanity: colors differ
    await expect(doWithdraw(W, await myRefundPk(), mkCoin(W, wrongColor))).rejects.toThrow();
    expect(await shieldedBalance()).toBe(bal); // atomic: no coin taken
  });

  // #9 — a coin whose value ≠ the requested amount must be rejected (guaranteed assert
  // coin.value == amount), so the surrendered value can never disagree with the EVM
  // transfer amount the MPC will sign. Atomic: balance unchanged.
  it('rejects a withdraw whose coin value does not equal the amount', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    const mismatched = mkCoin(W + 1n);                       // value W+1, but amount is W
    await expect(doWithdraw(W, await myRefundPk(), mismatched)).rejects.toThrow();
    expect(await shieldedBalance()).toBe(bal);              // atomic: no coin taken
  });

  // #10 — cannot withdraw more than the balance (wallet can't fund the spend).
  it('rejects withdraw exceeding the vault-token balance', async () => {
    const tooMuch = (await shieldedBalance()) + 1_000_000n;
    await expect(doWithdraw(tooMuch, await myRefundPk())).rejects.toThrow();
  });

  // #11 — only the original depositor (matching identity commitment) can claim.
  it('rejects claim from a non-depositor (identity commitment mismatch)', async () => {
    // Capture existing requests first so we pick THIS deposit's rid, not a stale one.
    const before = new Set(
      [...(await api.getLedgerState(providers, contractAddress))!.signetRequestNonce]
        .map(([k]) => Buffer.from(k).toString('hex')),
    );
    await deployedContract.callTx.deposit(
      testErc20Address, 1_600_000n, testEvmChainId, testEvmNonce + 15n, testEvmGasLimit,
      testEvmMaxFee, testEvmPriorityFee, testEvmValue, testCaip2Id, testKeyVersion,
      testPath, testAlgo, testDest, testParams, testOutputSchema, testRespondSchema,
    );
    const led = await api.getLedgerState(providers, contractAddress);
    const rid = [...led!.signetRequestNonce]
      .map(([k]) => k as Uint8Array)
      .find((k) => !before.has(Buffer.from(k).toString('hex')))!;
    const out = new Uint8Array(OUTPUT_DATA_SIZE); out[0] = 1;
    const sig = schnorrSign(jubjubSk, buildSignetMessage(rid, out), api.schnorrChallenge);
    // Swap in a different secret key → commitment no longer matches the stored path hex.
    const wrongSk = hash2x32(pad32('test:user:'), pad32('not-the-depositor'));
    await providers.privateStateProvider.set(VaultPrivateStateId, { secretKey: wrongSk });
    await expect(
      deployedContract.callTx.claim(rid, out, jubjubPk, sig.announcement, sig.response),
    ).rejects.toThrow();
    // Restore the real identity for any subsequent tests. We intentionally DON'T do a
    // second (success) claim here — the wrong-key rejection above is the whole assertion,
    // and that extra proof needlessly stacks proof-server memory (it OOMs the 13.6GB
    // standalone). The deposited request is simply left pending; nothing later depends on it.
    await providers.privateStateProvider.set(VaultPrivateStateId, { secretKey });
  });

  // #12 — deposit rejects a path that is not the canonical hex of the commitment.
  it('rejects a deposit whose path is not the canonical hex of the commitment', async () => {
    const badPath = new Uint8Array(PATH_SIZE); // all-zero: 0x00 is not a valid hex char
    await expect(
      deployedContract.callTx.deposit(
        testErc20Address, 1_700_000n, testEvmChainId, testEvmNonce + 16n, testEvmGasLimit,
        testEvmMaxFee, testEvmPriorityFee, testEvmValue, testCaip2Id, testKeyVersion,
        badPath, testAlgo, testDest, testParams, testOutputSchema, testRespondSchema,
      ),
    ).rejects.toThrow();
  });
});

