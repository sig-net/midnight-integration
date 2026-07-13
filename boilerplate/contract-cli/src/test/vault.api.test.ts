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
import { ethers } from 'ethers';
import { deriveEvmAddress } from '../crypto-utils';
import { startEvmHarness, type EvmHarness } from './evm-harness';
import { startMpcWatcher, type MpcWatcher } from './mpc-watcher';

const logDir = path.resolve(currentDir, '..', 'logs', 'tests', `vault-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
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

  // Local EVM (Hardhat) + a throwaway test MPC secp256k1 root — set in beforeAll.
  let evm: EvmHarness;
  let mpcSecpPriv: string;
  let mpcSecpPub: string;
  let testErc20Address: Buffer;            // deployed TestUSDC address
  let testEvmChainId: bigint;              // local node chain id
  let userEvmAddr: string;                 // derived from path=commitmentHex
  let vaultEvmAddr: string;                // derived from path="vault"
  let watcher: MpcWatcher;                 // polls the ledger, services new requests like the MPC

  const testAmount = 1_000_000n; // 1 USDC (6 decimals)
  const testEvmGasLimit = 100_000n;
  const testEvmMaxFee = 30_000_000_000n; // 30 gwei
  const testEvmPriorityFee = 1_000_000_000n; // 1 gwei
  const testEvmValue = 0n;

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

      providers = await api.configureProviders(walletCtx, config);

      // Local EVM + throwaway test MPC secp256k1 root.
      evm = await startEvmHarness();
      testErc20Address = Buffer.from(evm.usdcAddress.slice(2), 'hex');
      testEvmChainId = evm.chainId;
      const mpcWallet = ethers.Wallet.createRandom();
      mpcSecpPriv = mpcWallet.privateKey;
      mpcSecpPub = mpcWallet.signingKey.publicKey;
    },
    1000 * 60 * 10,
  );

  afterAll(async () => {
    watcher?.stop();
    await walletCtx?.wallet.stop().catch(() => {});
    await evm?.stop();
  });

  // Per-test proof-server restart so each test gets a fresh prover (cumulative proofs OOM it).
  // Set SKIP_PROOF_SERVER_RESTART=1 to disable (roomy runners, or to measure memory growth).
  beforeEach(() => {
    if (process.env.SKIP_PROOF_SERVER_RESTART) return;
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

    // From here on the MPC watcher reacts to on-chain requests (poll → broadcast → sign).
    watcher = startMpcWatcher({
      providers, contractAddress, provider: evm.provider,
      secp256k1RootPriv: mpcSecpPriv, jubjubSk,
    });
  });

  it('should initialize the vault address', async () => {
    // Derive the MPC-controlled EVM addresses and fund them on the local EVM.
    vaultEvmAddr = deriveEvmAddress(mpcSecpPub, contractAddress, 'vault');
    userEvmAddr = deriveEvmAddress(mpcSecpPub, contractAddress, commitmentHex);
    for (const addr of [vaultEvmAddr, userEvmAddr]) {
      await evm.mintUsdc(addr, 1_000_000_000n);          // 1000 USDC
      await evm.fundEth(addr, ethers.parseEther('10'));
    }
    const vaultBytes = new Uint8Array(Buffer.from(vaultEvmAddr.slice(2), 'hex'));

    const result = await deployedContract.callTx.initialize(vaultBytes);
    expect(result.public.txHash).toMatch(/[0-9a-f]{64}/);

    const ledger = await api.getLedgerState(providers, contractAddress);
    expect(ledger!.initialized).toBe(1n);
    expect(Buffer.from(ledger!.sepoliaVaultAddress)).toEqual(Buffer.from(vaultBytes));
  });

  it('should accept a deposit with calldata + gas params', async () => {
    const userNonce = BigInt(await evm.provider.getTransactionCount(userEvmAddr));
    const result = await deployedContract.callTx.deposit(
      testErc20Address,
      testAmount,
      testEvmChainId,
      userNonce,
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
    expect(ledger!.signetEvmNonce.lookup(requestId)).toBe(userNonce);
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
    // The watcher detected the deposit request, broadcast the user→vault USDC transfer on the
    // local EVM, observed success, and signed. The user submits claim with that signature.
    const mpc = await watcher.awaitResponse(requestId);
    expect(mpc.success).toBe(true);

    const result = await deployedContract.callTx.claim(
      requestId,
      mpc.outputData,
      api.randomBytes(32),
      jubjubPk,
      mpc.announcement,
      mpc.response,
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
  // completeWithdraw() re-mints to the withdrawer. These reuse the ~3M vault-token
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
  const mkNonce = (): Uint8Array => new Uint8Array(32).fill((nonceCtr++ % 250) + 1);
  const mkCoin = (value: bigint, color: Uint8Array = vaultColorBytes()) =>
    ({ nonce: mkNonce(), color, value });
  // EVM transfer dest: a valid address succeeds; address(0) reverts (→ refund).
  const BURN_DEST = '0x000000000000000000000000000000000000dEaD';
  const ZERO_DEST = '0x0000000000000000000000000000000000000000';
  const addr20 = (a: string): Uint8Array => new Uint8Array(Buffer.from(a.slice(2), 'hex'));
  const doWithdraw = async (amount: bigint, coin = mkCoin(amount), dest = BURN_DEST) => {
    const evmNonce = BigInt(await evm.provider.getTransactionCount(vaultEvmAddr));
    return deployedContract.callTx.withdraw(
      testErc20Address, amount, coin, addr20(dest), testEvmChainId, evmNonce,
      testEvmGasLimit, testEvmMaxFee, testEvmPriorityFee, testEvmValue, testCaip2Id,
      testKeyVersion, testAlgo, testDest, testParams, testOutputSchema, testRespondSchema,
    );
  };
  const pendingRidHexes = async (): Promise<string[]> => {
    const led = await api.getLedgerState(providers, contractAddress);
    return [...led!.refundCommitment].map(([k]) => Buffer.from(k).toString('hex'));
  };
  const withdrawAndRid = async (amount: bigint, dest = BURN_DEST): Promise<Uint8Array> => {
    const before = new Set(await pendingRidHexes());
    await doWithdraw(amount, mkCoin(amount), dest);
    const newHex = (await pendingRidHexes()).find((h) => !before.has(h))!;
    return new Uint8Array(Buffer.from(newHex, 'hex'));
  };
  // Recipient-only refund: the withdrawer awaits the MPC's signed response and submits
  // completeWithdraw with a fresh random nonce (only a failure is refundable, mints to self).
  const mpcComplete = async (rid: Uint8Array) => {
    const mpc = await watcher.awaitResponse(rid);
    await deployedContract.callTx.completeWithdraw(rid, mpc.outputData, api.randomBytes(32), jubjubPk, mpc.announcement, mpc.response);
    return mpc;
  };

  // #1/#2 — withdraw draws from balance; deadbeef refund restores it (to self).
  it('withdraws from balance, then refunds the value on a deadbeef failure', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    expect(bal).toBeGreaterThanOrEqual(W);
    const rid = await withdrawAndRid(W, ZERO_DEST);
    expect(await shieldedBalance()).toBe(bal - W);           // value surrendered
    const led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundCommitment.member(rid)).toBe(true);
    expect((await mpcComplete(rid)).success).toBe(false);   // EVM transfer reverts → refund
    expect(await shieldedBalance()).toBe(bal);              // restored (to self)
    const led2 = await api.getLedgerState(providers, contractAddress);
    expect(led2!.refundCommitment.member(rid)).toBe(false);  // cleaned up
  });


  // #5 — completeWithdraw on a success finalizes: no refund, request cleaned up. The
  // success path needs no identity, so anyone can call it (here the same wallet does).
  it('completeWithdraw finalizes a successful withdrawal (no refund, cleaned up)', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    const rid = await withdrawAndRid(W);
    expect(await shieldedBalance()).toBe(bal - W);
    expect((await mpcComplete(rid)).success).toBe(true);    // EVM transfer succeeds → finalize
    expect(await shieldedBalance()).toBe(bal - W);           // NOT refunded
    const led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundCommitment.member(rid)).toBe(false);  // cleaned up
  });

  // (removed) refund-to-a-second-wallet: recipient-only completeWithdraw always mints to the
  // withdrawer, so a caller-chosen refund key no longer exists.

  // W3 — a forged / wrong-key MPC signature on completeWithdraw must be rejected (no refund mint).
  it('rejects completeWithdraw with a forged or wrong-key MPC signature (no refund minted)', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    const rid = await withdrawAndRid(W, ZERO_DEST);
    expect(await shieldedBalance()).toBe(bal - W);           // coin surrendered

    // Real MPC response over the (failed) EVM result, from the watcher.
    const mpc = await watcher.awaitResponse(rid);
    expect(mpc.success).toBe(false);

    // (a) Flip one bit of the response scalar → s·G ≠ R + h·pk.
    await expect(
      deployedContract.callTx.completeWithdraw(rid, mpc.outputData, api.randomBytes(32), jubjubPk, mpc.announcement, mpc.response ^ 1n),
    ).rejects.toThrow();
    expect(await shieldedBalance()).toBe(bal - W);           // NO refund minted
    let led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundCommitment.member(rid)).toBe(true);    // still pending

    // (b) Different public key → pk hash ≠ stored mpcPubKeyHash.
    await expect(
      deployedContract.callTx.completeWithdraw(
        rid, mpc.outputData, api.randomBytes(32), { x: jubjubPk.x + 1n, y: jubjubPk.y }, mpc.announcement, mpc.response),
    ).rejects.toThrow('Unauthorized: wrong public key');
    expect(await shieldedBalance()).toBe(bal - W);           // still no mint
    led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundCommitment.member(rid)).toBe(true);    // still pending

    // The real signature completes it → refund restores the balance (to self).
    await deployedContract.callTx.completeWithdraw(rid, mpc.outputData, api.randomBytes(32), jubjubPk, mpc.announcement, mpc.response);
    expect(await shieldedBalance()).toBe(bal);
    led = await api.getLedgerState(providers, contractAddress);
    expect(led!.refundCommitment.member(rid)).toBe(false);   // cleaned up
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
    await expect(doWithdraw(W, mkCoin(W, wrongColor))).rejects.toThrow();
    expect(await shieldedBalance()).toBe(bal); // atomic: no coin taken
  });

  // #9 — a coin whose value ≠ the requested amount must be rejected (guaranteed assert
  // coin.value == amount), so the surrendered value can never disagree with the EVM
  // transfer amount the MPC will sign. Atomic: balance unchanged.
  it('rejects a withdraw whose coin value does not equal the amount', async () => {
    const W = 200_000n;
    const bal = await shieldedBalance();
    const mismatched = mkCoin(W + 1n);                       // value W+1, but amount is W
    await expect(doWithdraw(W, mismatched)).rejects.toThrow();
    expect(await shieldedBalance()).toBe(bal);              // atomic: no coin taken
  });

  // #10 — cannot withdraw more than the balance (wallet can't fund the spend).
  it('rejects withdraw exceeding the vault-token balance', async () => {
    const tooMuch = (await shieldedBalance()) + 1_000_000n;
    await expect(doWithdraw(tooMuch)).rejects.toThrow();
  });

  // #11 — only the original depositor (matching identity commitment) can claim.
  it('rejects claim from a non-depositor (identity commitment mismatch)', async () => {
    // Capture existing requests first so we pick THIS deposit's rid, not a stale one.
    const before = new Set(
      [...(await api.getLedgerState(providers, contractAddress))!.signetRequestNonce]
        .map(([k]) => Buffer.from(k).toString('hex')),
    );
    await deployedContract.callTx.deposit(
      testErc20Address, 1_600_000n, testEvmChainId, 15n, testEvmGasLimit,
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
      deployedContract.callTx.claim(rid, out, api.randomBytes(32), jubjubPk, sig.announcement, sig.response),
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
        testErc20Address, 1_700_000n, testEvmChainId, 16n, testEvmGasLimit,
        testEvmMaxFee, testEvmPriorityFee, testEvmValue, testCaip2Id, testKeyVersion,
        badPath, testAlgo, testDest, testParams, testOutputSchema, testRespondSchema,
      ),
    ).rejects.toThrow();
  });
});

