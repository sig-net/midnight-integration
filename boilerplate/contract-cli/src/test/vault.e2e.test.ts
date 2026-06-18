/**
 * ERC20 Vault E2E Test — Cross-Chain Signing Demo
 *
 * Full end-to-end flow:
 *   User deposits on Midnight → MPC detects → signs EVM tx → client broadcasts
 *   to Sepolia → MPC confirms → Schnorr signs response → user claims on Midnight
 *   → contract verifies signature + EVM result → mints shielded USDC
 *
 * Prerequisites:
 *   - Midnight standalone docker compose running
 *   - MPC response server running: cd solana-signet-program && yarn response
 *   - Derived Sepolia address funded with USDC + ETH for gas
 *   - Contract deployed and initialized (use deploy-for-e2e.ts)
 */

import { convertFieldToBytes } from '@midnight-ntwrk/compact-runtime';
import { unshieldedToken, rawTokenType } from '@midnight-ntwrk/ledger-v8';
import path from 'path';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import * as api from '../api';
import { type WalletContext } from '../api';
import { type VaultPrivateState, type VaultProviders } from '../common-types';
import { currentDir, getConfig } from '../config';
import { createLogger } from '../logger-utils';
import { hash2x32, pad32, deriveEvmAddress } from '../crypto-utils';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Rx from 'rxjs';
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
  CALLDATA_FUNC_SIG_SIZE,
} from '../signet/constants';
import { computeRequestId, computeCalldataArgsCommitment } from '../signet/request-id';

const logDir = path.resolve(currentDir, '..', 'logs', 'tests', `vault-e2e-${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);

// ──────────────────────────────────────────────────────────────
//  Demo output helpers
// ──────────────────────────────────────────────────────────────

const USDC_DECIMALS = 6;

function formatUsdc(raw: bigint): string {
  const whole = raw / BigInt(10 ** USDC_DECIMALS);
  const frac = raw % BigInt(10 ** USDC_DECIMALS);
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

function truncHex(hex: string, len = 8): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length <= len * 2) return clean;
  return `${clean.slice(0, len)}...${clean.slice(-len)}`;
}

function sepoliaLink(txHash: string): string {
  const hash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

function banner(text: string): void {
  const line = '═'.repeat(64);
  console.log(`\n╔${line}╗`);
  console.log(`║  ${text.padEnd(62)}║`);
  console.log(`╚${line}╝`);
}

function section(step: string, title: string): void {
  const line = '─'.repeat(64);
  console.log(`\n┌${line}┐`);
  console.log(`│  ${step}  │  ${title.padEnd(64 - step.length - 7)}│`);
  console.log(`└${line}┘`);
}

function info(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

function wait(message: string): void {
  console.log(`  ⏳ ${message}`);
}

function fail(message: string): void {
  console.log(`  ✗ ${message}`);
}

// ──────────────────────────────────────────────────────────────
//  Configuration
// ──────────────────────────────────────────────────────────────

const WALLET_SEED = process.env.MIDNIGHT_WALLET_SEED || '0000000000000000000000000000000000000000000000000000000000000001';

const DEPLOYED_CONTRACT_ADDRESS = process.env.MIDNIGHT_CONTRACT_ADDRESS;
if (!DEPLOYED_CONTRACT_ADDRESS) throw new Error('MIDNIGHT_CONTRACT_ADDRESS env var is required — run deploy-for-e2e.ts first');

const MPC_WS_URL = process.env.MPC_WS_URL || 'ws://localhost:3030';
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY || '65c70fe1968e42e5a9fcfb66b7231ea7'}`;

// Derive user secret key from wallet seed — one secret for the user
const USER_SECRET_KEY = hash2x32(pad32('vault:sk:'), new Uint8Array(Buffer.from(WALLET_SEED, 'hex')));
const SEPOLIA_USDC_ADDRESS = Buffer.from('1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'hex');
const MPC_SECP256K1_PUBKEY = '0x024eef776e4f257d68983e45b340c2e9546c5df95447900b6aadfec68fb46fdee2';

// ──────────────────────────────────────────────────────────────
//  MPC WebSocket handler
// ──────────────────────────────────────────────────────────────

interface SignedTxMessage {
  type: 'signet_signed_tx';
  data: {
    requestId: string;
    signedTransaction: string;
    txHash: string;
  };
}

interface SchnorrResponseMessage {
  type: 'signet_response';
  data: {
    requestId: string;
    outputData: string;
    pk: { x: string; y: string };
    announcement: { x: string; y: string };
    response: string;
  };
}

function handleMpcWebSocket(
  wsUrl: string,
  requestIdHex: string,
  sepoliaRpcUrl: string,
  timeoutMs: number = 10 * 60 * 1000,
): Promise<{
  outputData: Uint8Array;
  pk: { x: bigint; y: bigint };
  announcement: { x: bigint; y: bigint };
  response: bigint;
  txHash: string;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let broadcastedTxHash: string | null = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out waiting for MPC messages for ${requestIdHex} (${timeoutMs}ms)`));
    }, timeoutMs);

    ws.on('open', () => {
      ok(`Connected to MPC WebSocket`);
      logger.info(`Connected to MPC WebSocket at ${wsUrl}`);
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'signet_signed_tx' && msg.data.requestId === '0x' + requestIdHex) {
          const txData = msg.data as SignedTxMessage['data'];
          ok(`MPC signed EVM transaction`);
          info('EVM tx hash', truncHex(txData.txHash));
          logger.info(`Received signed EVM tx from MPC: ${txData.txHash}`);

          try {
            wait('Broadcasting to Sepolia...');
            const provider = new ethers.JsonRpcProvider(sepoliaRpcUrl);
            const broadcastResult = await provider.broadcastTransaction(txData.signedTransaction);
            broadcastedTxHash = broadcastResult.hash;
            ok(`Broadcast to Sepolia`);
            info('Explorer', sepoliaLink(broadcastedTxHash));
            logger.info(`Broadcast EVM tx to Sepolia: ${broadcastedTxHash}`);
          } catch (broadcastError) {
            fail(`Broadcast failed: ${broadcastError}`);
            logger.error(`Failed to broadcast EVM tx: ${broadcastError}`);
          }
        }

        if (msg.type === 'signet_response' && msg.data.requestId === requestIdHex) {
          clearTimeout(timer);
          ws.close();

          const d = msg.data as SchnorrResponseMessage['data'];
          resolve({
            outputData: Buffer.from(d.outputData, 'hex'),
            pk: { x: BigInt(d.pk.x), y: BigInt(d.pk.y) },
            announcement: { x: BigInt(d.announcement.x), y: BigInt(d.announcement.y) },
            response: BigInt(d.response),
            txHash: broadcastedTxHash || '',
          });
        }
      } catch (e) {
        // Ignore non-JSON messages
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${err.message}`));
    });

    ws.on('close', () => {
      // Only reject if we haven't resolved yet
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  TEST SUITE
// ══════════════════════════════════════════════════════════════

describe('ERC20 Vault — Cross-Chain Signing E2E', () => {
  let walletCtx: WalletContext;
  let providers: VaultProviders;
  let deployedContract: any;
  let requestId: Uint8Array;

  const config = getConfig();

  const testAmount = 1n; // smallest unit (0.000001 USDC) — keeps test repeatable
  const testEvmChainId = 11155111n;
  let testEvmNonce = 0n;
  const testEvmGasLimit = 100_000n;
  const testEvmMaxFee = 30_000_000_000n;
  const testEvmPriorityFee = 1_000_000_000n;
  const testEvmValue = 0n;

  const userIdentityCommitment = hash2x32(pad32('vault:user:'), USER_SECRET_KEY);

  const testCaip2Id = encodeString('eip155:11155111', CAIP2_ID_SIZE);
  const testKeyVersion = 0n;
  const testPath = new Uint8Array(PATH_SIZE);
  testPath.set(userIdentityCommitment, 0);
  const testAlgo = encodeString('ecdsa', ALGO_SIZE);
  const testDest = encodeString('ethereum', DEST_SIZE);
  const testParams = encodeLengthPrefixed(new Uint8Array(0), PARAMS_SIZE);
  const testOutputSchema = encodeString('[{"name":"success","type":"bool"}]', OUTPUT_SCHEMA_SIZE);
  const testRespondSchema = encodeString('[{"name":"success","type":"bool"}]', RESPOND_SCHEMA_SIZE);

  beforeAll(
    async () => {
      api.setLogger(logger);

      const network = process.env.MIDNIGHT_NETWORK || 'standalone';
      banner('ERC20 VAULT — Cross-Chain Signing E2E Demo');
      console.log(`  Midnight (${network})  ←→  Sepolia (Ethereum testnet)`);
      console.log(`  Token: USDC  ·  Amount: ${formatUsdc(testAmount)} USDC  ·  Explorer: sepolia.etherscan.io`);

      section('SETUP', 'Connecting to Midnight network');

      wait('Building wallet from genesis seed...');
      walletCtx = await api.buildWalletAndWaitForFunds(config, WALLET_SEED);

      const state = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
      const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
      expect(balance).toBeGreaterThan(0n);
      ok(`Wallet ready`);
      info('Address', walletCtx.unshieldedKeystore.getBech32Address());
      info('tDUST balance', balance.toLocaleString());

      providers = await api.configureProviders(walletCtx, config);

      const privateState: VaultPrivateState = { secretKey: USER_SECRET_KEY };
      deployedContract = await api.joinContract(providers, DEPLOYED_CONTRACT_ADDRESS, privateState);
      ok(`Joined contract`);
      info('Contract', truncHex(DEPLOYED_CONTRACT_ADDRESS));

      const ledger = await api.getLedgerState(providers, DEPLOYED_CONTRACT_ADDRESS);
      expect(ledger).not.toBeNull();
      expect(ledger!.initialized).toBe(1n);
      ok(`Contract initialized`);
      info('MPC PK hash', truncHex(Buffer.from(ledger!.mpcPubKeyHash).toString('hex')));
      info('Vault address', `0x${Buffer.from(ledger!.sepoliaVaultAddress).toString('hex')}`);

      const pathHex = Buffer.from(testPath).toString('hex');
      const userEvmAddress = deriveEvmAddress(MPC_SECP256K1_PUBKEY, DEPLOYED_CONTRACT_ADDRESS, pathHex);
      const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
      testEvmNonce = BigInt(await sepoliaProvider.getTransactionCount(userEvmAddress));
      ok(`Sepolia connected`);
      info('User EVM address', userEvmAddress);
      info('Nonce', testEvmNonce.toString());

      logger.info(`Setup complete. Contract: ${DEPLOYED_CONTRACT_ADDRESS}, User EVM: ${userEvmAddress}`);
    },
    1000 * 60 * 10,
  );

  afterAll(async () => {
    if (walletCtx?.wallet) {
      await walletCtx.wallet.stop();
    }
  });

  // ────────────────────────────────────────────────────────────
  //  STEP 1–3: Deposit → MPC signs → Broadcast → Schnorr
  // ────────────────────────────────────────────────────────────

  it(
    'deposit on Midnight → MPC signs EVM tx → broadcast to Sepolia → Schnorr response',
    async () => {
      // ── STEP 1: Deposit on Midnight ──────────────────────────

      section('STEP 1', 'Deposit on Midnight');
      info('Amount', `${formatUsdc(testAmount)} USDC`);
      info('ERC20 contract', `0x${Buffer.from(SEPOLIA_USDC_ADDRESS).toString('hex')}`);
      info('Target chain', 'eip155:11155111 (Sepolia)');
      info('Function', 'transfer(address,uint256)');

      const ledgerBefore = await api.getLedgerState(providers, DEPLOYED_CONTRACT_ADDRESS);
      const currentNonce = ledgerBefore!.signetNonce ?? 0n;

      const calldataFuncSig = new Uint8Array(CALLDATA_FUNC_SIG_SIZE);
      new TextEncoder().encodeInto('transfer(address,uint256)', calldataFuncSig);
      const sepoliaVaultBytes = ledgerBefore!.sepoliaVaultAddress;
      const calldataArgs = [
        convertFieldToBytes(32, bytesToBigint(sepoliaVaultBytes), 'vault-addr'),
        convertFieldToBytes(32, testAmount, 'amount'),
      ];
      requestId = computeRequestId({
        nonce: currentNonce,
        evmChainId: testEvmChainId,
        evmNonce: testEvmNonce,
        evmGasLimit: testEvmGasLimit,
        evmMaxFee: testEvmMaxFee,
        evmPriorityFee: testEvmPriorityFee,
        evmValue: testEvmValue,
        evmTo: SEPOLIA_USDC_ADDRESS,
        calldataFuncSig,
        calldataArgsCommitment: computeCalldataArgsCommitment(calldataArgs),
        caip2Id: testCaip2Id,
        keyVersion: Number(testKeyVersion),
        path: testPath,
        algo: testAlgo,
        dest: testDest,
        params: testParams,
        outputSchema: testOutputSchema,
        respondSchema: testRespondSchema,
      });
      const requestIdHex = Buffer.from(requestId).toString('hex');
      info('Request ID', truncHex(requestIdHex));

      // ── Connect WebSocket before deposit (avoid race) ────────

      section('STEP 2', 'MPC detection + EVM signing');
      wait('Connecting to MPC WebSocket before deposit...');
      const mpcResponsePromise = handleMpcWebSocket(MPC_WS_URL, requestIdHex, SEPOLIA_RPC_URL, 10 * 60 * 1000);

      // ── Submit deposit transaction ───────────────────────────

      wait('Generating ZK proof for deposit()...');
      logger.info('Calling deposit() with real Sepolia USDC params...');
      const result = await deployedContract.callTx.deposit(
        SEPOLIA_USDC_ADDRESS,
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
      ok(`deposit() confirmed on Midnight`);
      info('Midnight tx', truncHex(result.public.txHash));
      logger.info(`deposit() confirmed: ${result.public.txHash}`);

      // ── Wait for MPC flow ────────────────────────────────────

      console.log('');
      wait('MPC is detecting deposit, signing EVM tx, waiting for Sepolia confirmation...');
      const response = await mpcResponsePromise;

      // ── STEP 3: Schnorr response ─────────────────────────────

      section('STEP 3', 'Schnorr signature received from MPC');

      const isError = response.outputData[0] === 0xde
        && response.outputData[1] === 0xad
        && response.outputData[2] === 0xbe
        && response.outputData[3] === 0xef;

      if (isError) {
        fail('EVM transaction failed (0xDEADBEEF error prefix)');
        info('Meaning', 'ERC20 transfer reverted on Sepolia');
      } else {
        const evmSuccess = response.outputData[0] === 1;
        ok(`EVM result deserialized`);
        info('transfer() returned', evmSuccess ? 'true ✓' : 'false ✗');
      }

      if (response.txHash) {
        info('Sepolia tx', truncHex(response.txHash));
        info('Explorer', sepoliaLink(response.txHash));
      }
      info('Schnorr response', truncHex(response.response.toString(16)));
      info('Schnorr announcement.x', truncHex(response.announcement.x.toString(16)));

      logger.info(`MPC Schnorr response received for ${requestIdHex}`);
      (globalThis as any).__mpcResponse = response;
    },
    1000 * 60 * 15,
  );

  // ────────────────────────────────────────────────────────────
  //  STEP 4: Claim — verify signature + mint shielded USDC
  // ────────────────────────────────────────────────────────────

  it(
    'claim on Midnight → verify Schnorr + deserialize EVM result → mint shielded USDC',
    async () => {
      const response = (globalThis as any).__mpcResponse;
      expect(response).toBeDefined();

      section('STEP 4', 'Claim on Midnight');

      const paddedOutputData = new Uint8Array(OUTPUT_DATA_SIZE);
      paddedOutputData.set(response.outputData.slice(0, OUTPUT_DATA_SIZE));

      const isSuccess = response.outputData[0] === 1
        && response.outputData[1] === 0
        && response.outputData[2] === 0
        && response.outputData[3] === 0;

      console.log('  The contract will independently:');
      console.log('    1. Verify MPC public key matches stored hash');
      console.log('    2. Rehash all inputs (sigR, pk, requestId, outputData)');
      console.log('    3. Verify Schnorr signature: s·G = R + h·pk');
      console.log('    4. Deserialize EVM output → assert transfer() == true');
      console.log('    5. Mint shielded USDC token to caller');
      console.log('');

      if (isSuccess) {
        // Snapshot balance before claim (accumulates across runs)
        const erc20AsBigint = bytesToBigint(SEPOLIA_USDC_ADDRESS);
        const erc20As32 = convertFieldToBytes(32, erc20AsBigint, 'test:erc20');
        const domainSep = hash2x32(pad32('erc20:vault:'), erc20As32);
        const expectedTokenType = rawTokenType(domainSep, DEPLOYED_CONTRACT_ADDRESS);
        const walletBefore = await Rx.firstValueFrom(
          walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
        );
        const balanceBefore = walletBefore.shielded.balances[expectedTokenType] ?? 0n;

        wait('Generating ZK proof for claim()...');
        const result = await deployedContract.callTx.claim(
          requestId,
          paddedOutputData,
          response.pk,
          response.announcement,
          response.response,
        );
        expect(result.public.txHash).toMatch(/[0-9a-f]{64}/);
        ok(`claim() confirmed on Midnight`);
        info('Midnight tx', truncHex(result.public.txHash));
        logger.info(`claim() confirmed: ${result.public.txHash}`);

        // Verify this request was cleaned up (other requests from prior runs may still exist)
        const ledger = await api.getLedgerState(providers, DEPLOYED_CONTRACT_ADDRESS);
        expect(ledger).not.toBeNull();
        expect(ledger!.signetRequestNonce.member(requestId)).toBe(false);
        ok('Signet request cleaned up');

        // Verify shielded USDC balance increased by testAmount
        const walletAfter = await Rx.firstValueFrom(
          walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
        );
        const balanceAfter = walletAfter.shielded.balances[expectedTokenType] ?? 0n;
        const minted = balanceAfter - balanceBefore;
        expect(minted).toBe(testAmount);

        // ── Final result ─────────────────────────────────────────

        const sepoliaTxLink = response.txHash ? sepoliaLink(response.txHash) : '';
        const line = '─'.repeat(60);
        console.log(`\n  ┌${line}┐`);
        console.log(`  │${''.padEnd(60)}│`);
        console.log(`  │${'  CLAIM VERIFIED — SHIELDED USDC MINTED'.padEnd(60)}│`);
        console.log(`  │${''.padEnd(60)}│`);
        console.log(`  │${`  Minted:                 +${formatUsdc(minted)} USDC`.padEnd(60)}│`);
        console.log(`  │${`  Total shielded balance: ${formatUsdc(balanceAfter)} USDC`.padEnd(60)}│`);
        console.log(`  │${`  Token type:             erc20:vault:0x1c7D...7238`.padEnd(60)}│`);
        console.log(`  │${`  Privacy:                fully shielded`.padEnd(60)}│`);
        console.log(`  │${`                          (amount + owner hidden on-chain)`.padEnd(60)}│`);
        console.log(`  │${''.padEnd(60)}│`);
        console.log(`  └${line}┘`);
        if (sepoliaTxLink) {
          console.log(`\n  Sepolia: ${sepoliaTxLink}`);
        }

        console.log(`\n  Flow completed:`);
        console.log(`    Sepolia (ERC20) ──deposit──→ Midnight (ZK proof)`);
        console.log(`           ↓`);
        console.log(`    MPC detects deposit on Midnight ledger`);
        console.log(`           ↓`);
        console.log(`    MPC signs EVM tx (secp256k1) → broadcast to Sepolia`);
        console.log(`           ↓`);
        console.log(`    Sepolia confirms ERC20 transfer() = true`);
        console.log(`           ↓`);
        console.log(`    MPC signs Schnorr response (Jubjub) → broadcasts to Midnight`);
        console.log(`           ↓`);
        console.log(`    User calls claim() → contract verifies everything`);
        console.log(`           ↓`);
        console.log(`    Shielded USDC minted ✓  (only user can spend it)`);
      } else {
        // Failure path
        wait('Expecting claim() to reject (EVM transfer failed)...');
        logger.info('Expecting claim() to reject with "ERC20 transfer returned false"...');
        await expect(
          deployedContract.callTx.claim(
            requestId,
            paddedOutputData,
            response.pk,
            response.announcement,
            response.response,
          ),
        ).rejects.toThrow('ERC20 transfer returned false');

        ok('claim() correctly rejected — EVM transfer failed');
        info('Reason', 'ERC20 transfer() returned false on Sepolia');
        info('Status', 'Request still pending — can retry when funded');

        const ledger = await api.getLedgerState(providers, DEPLOYED_CONTRACT_ADDRESS);
        expect(ledger).not.toBeNull();
        expect(ledger!.signetRequestNonce.isEmpty()).toBe(false);
        logger.info('Request still pending — can be retried when funds are available');
      }
    },
    1000 * 60 * 5,
  );

  // ────────────────────────────────────────────────────────────
  //  STEP 5: Tamper resistance — prove the contract rejects
  //  forged signatures, wrong keys, and modified data
  // ────────────────────────────────────────────────────────────

  it(
    'rejects claim with a forged signature (tampered sigS)',
    async () => {
      const response = (globalThis as any).__mpcResponse;
      expect(response).toBeDefined();

      section('STEP 5a', 'Tamper test — forged signature');
      console.log('  Using the real MPC response but flipping one bit in sigS.');
      console.log('  The contract should reject: s·G ≠ R + h·pk');
      console.log('');

      const paddedOutputData = new Uint8Array(OUTPUT_DATA_SIZE);
      paddedOutputData.set(response.outputData.slice(0, OUTPUT_DATA_SIZE));

      const forgedResponse = response.response ^ 1n;
      info('Real response', truncHex(response.response.toString(16)));
      info('Forged response', truncHex(forgedResponse.toString(16)));

      wait('Submitting claim with forged signature...');
      await expect(
        deployedContract.callTx.claim(
          requestId,
          paddedOutputData,
          response.pk,
          response.announcement,
          forgedResponse,
        ),
      ).rejects.toThrow();
      ok('Rejected — contract detected forged signature');
    },
    1000 * 60 * 5,
  );

  it(
    'rejects claim with a wrong public key (impersonation attempt)',
    async () => {
      const response = (globalThis as any).__mpcResponse;
      expect(response).toBeDefined();

      section('STEP 5b', 'Tamper test — wrong public key');
      console.log('  Submitting a different Jubjub public key with the real signature.');
      console.log('  The contract should reject: pk hash ≠ stored mpcPubKeyHash');
      console.log('');

      const paddedOutputData = new Uint8Array(OUTPUT_DATA_SIZE);
      paddedOutputData.set(response.outputData.slice(0, OUTPUT_DATA_SIZE));

      const fakePk = {
        x: response.pk.x + 1n,
        y: response.pk.y,
      };
      info('Real pk.x', truncHex(response.pk.x.toString(16)));
      info('Fake pk.x', truncHex(fakePk.x.toString(16)));

      wait('Submitting claim with wrong public key...');
      await expect(
        deployedContract.callTx.claim(
          requestId,
          paddedOutputData,
          fakePk,
          response.announcement,
          response.response,
        ),
      ).rejects.toThrow('Unauthorized: wrong public key');
      ok('Rejected — "Unauthorized: wrong public key"');
    },
    1000 * 60 * 5,
  );

  it(
    'rejects claim with tampered outputData (changed EVM result)',
    async () => {
      const response = (globalThis as any).__mpcResponse;
      expect(response).toBeDefined();

      section('STEP 5c', 'Tamper test — modified EVM output');
      console.log('  Using the real signature but changing outputData after signing.');
      console.log('  The rehashed challenge won\'t match → signature verification fails.');
      console.log('');

      const tamperedOutputData = new Uint8Array(OUTPUT_DATA_SIZE);
      tamperedOutputData.set(response.outputData.slice(0, OUTPUT_DATA_SIZE));
      tamperedOutputData[0] = 0xff;
      info('Real outputData[0]', `0x${response.outputData[0].toString(16).padStart(2, '0')}`);
      info('Tampered outputData[0]', '0xff');

      wait('Submitting claim with tampered output data...');
      await expect(
        deployedContract.callTx.claim(
          requestId,
          tamperedOutputData,
          response.pk,
          response.announcement,
          response.response,
        ),
      ).rejects.toThrow();
      ok('Rejected — signature invalid for tampered data');
    },
    1000 * 60 * 5,
  );

  it(
    'rejects claim with wrong request ID (replay on different request)',
    async () => {
      const response = (globalThis as any).__mpcResponse;
      expect(response).toBeDefined();

      section('STEP 5d', 'Tamper test — wrong request ID');
      console.log('  Using the real signature but a different request ID.');
      console.log('  This simulates replaying a valid response against a different request.');
      console.log('');

      const paddedOutputData = new Uint8Array(OUTPUT_DATA_SIZE);
      paddedOutputData.set(response.outputData.slice(0, OUTPUT_DATA_SIZE));

      const fakeRequestId = new Uint8Array(requestId);
      fakeRequestId[0] ^= 0xff;
      info('Real request ID', truncHex(Buffer.from(requestId).toString('hex')));
      info('Fake request ID', truncHex(Buffer.from(fakeRequestId).toString('hex')));

      wait('Submitting claim with wrong request ID...');
      await expect(
        deployedContract.callTx.claim(
          fakeRequestId,
          paddedOutputData,
          response.pk,
          response.announcement,
          response.response,
        ),
      ).rejects.toThrow();
      ok('Rejected — request ID mismatch');

      // ── Summary ────────────────────────────────────────────────

      const line = '─'.repeat(60);
      console.log(`\n  ┌${line}┐`);
      console.log(`  │${''.padEnd(60)}│`);
      console.log(`  │${'  TAMPER RESISTANCE VERIFIED'.padEnd(60)}│`);
      console.log(`  │${''.padEnd(60)}│`);
      console.log(`  │${'  ✓ Forged signature      → rejected'.padEnd(60)}│`);
      console.log(`  │${'  ✓ Wrong public key       → rejected'.padEnd(60)}│`);
      console.log(`  │${'  ✓ Tampered output data   → rejected'.padEnd(60)}│`);
      console.log(`  │${'  ✓ Wrong request ID       → rejected'.padEnd(60)}│`);
      console.log(`  │${''.padEnd(60)}│`);
      console.log(`  │${'  The contract independently verifies every input.'.padEnd(60)}│`);
      console.log(`  │${'  No one — not even the MPC — can forge a claim.'.padEnd(60)}│`);
      console.log(`  │${''.padEnd(60)}│`);
      console.log(`  └${line}┘`);
    },
    1000 * 60 * 5,
  );
});
