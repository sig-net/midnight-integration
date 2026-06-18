/**
 * Deploy the ERC20 vault contract for the MPC response server.
 *
 * Usage:
 *   MPC_ROOT_KEY=0x<64hex> MPC_PUBLIC_KEY=<130hex> npx tsx src/deploy-for-mpc.ts
 *
 * The deployer needs:
 *   - MPC_ROOT_KEY: hex-encoded 32-byte root key (used to derive Jubjub keypair for on-chain auth)
 *   - MPC_PUBLIC_KEY: 65-byte uncompressed secp256k1 public key (130 hex chars, starts with 04)
 *
 * This script:
 *   1. Builds a wallet from the genesis seed (devnet has pre-funded it)
 *   2. Deploys the vault contract with the MPC Jubjub key sealed at deploy
 *   3. Derives the sepoliaVaultAddress from the MPC PUBLIC key
 *   4. Calls initialize(sepoliaVaultAddress) (deployer-gated)
 *   5. Prints the env vars needed for the response server
 */

import path from 'path';
import * as api from './api';
import type { VaultPrivateState } from './common-types';
import { currentDir, StandaloneConfig } from './config';
import { createLogger } from './logger-utils';
import { deriveJubjubKeypair } from './signet/schnorr';
import { PATH_SIZE } from './signet/constants';
import { hash2x32, pad32, deriveEvmAddress, GENESIS_MINT_WALLET_SEED } from './crypto-utils';

const logDir = path.resolve(currentDir, '..', 'logs', 'deploy', `deploy-${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);
api.setLogger(logger);

// ---- Config ----

const MPC_ROOT_KEY_HEX = process.env.MPC_ROOT_KEY;
if (!MPC_ROOT_KEY_HEX || !/^0x[a-fA-F0-9]{64}$/.test(MPC_ROOT_KEY_HEX)) {
  console.error('ERROR: Set MPC_ROOT_KEY=0x<64-hex-chars> (32-byte root key for Jubjub derivation)');
  process.exit(1);
}

const MPC_PUBLIC_KEY_HEX = process.env.MPC_PUBLIC_KEY;
if (!MPC_PUBLIC_KEY_HEX || !/^04[a-fA-F0-9]{128}$/.test(MPC_PUBLIC_KEY_HEX)) {
  console.error('ERROR: Set MPC_PUBLIC_KEY=<130-hex-chars> (65-byte uncompressed secp256k1 public key, starts with 04)');
  process.exit(1);
}

const walletSeed = process.env.WALLET_SEED || GENESIS_MINT_WALLET_SEED;

// If not provided, sepoliaVaultAddress will be derived from the deployed contract address
const SEPOLIA_VAULT_ADDRESS_HEX = process.env.SEPOLIA_VAULT_ADDRESS;

// ---- Main ----

async function main() {
  const config = new StandaloneConfig();

  // Derive Jubjub keypair from MPC root key (for on-chain Schnorr auth)
  const rootKeyBytes = new Uint8Array(Buffer.from(MPC_ROOT_KEY_HEX!.replace('0x', ''), 'hex'));
  const { pk: mpcJubjubPk } = deriveJubjubKeypair(rootKeyBytes);

  console.log('=== Midnight ERC20 Vault: Deploy for MPC ===\n');
  console.log(`MPC root key: ${MPC_ROOT_KEY_HEX!.slice(0, 16)}...`);
  console.log(`MPC public key: ${MPC_PUBLIC_KEY_HEX!.slice(0, 20)}...`);

  // 1. Build wallet
  console.log('\nBuilding wallet from genesis seed...');
  const walletCtx = await api.buildWalletAndWaitForFunds(config, walletSeed);
  console.log(`Wallet address: ${walletCtx.unshieldedKeystore.getBech32Address()}\n`);

  // 2. Configure providers
  console.log('Configuring providers...');
  const providers = await api.configureProviders(walletCtx, config);

  // 3. Deploy (deployer secret derived from wallet seed — gates initialize())
  console.log('Deploying vault contract...');
  const deployerSecretKey = hash2x32(pad32('vault:sk:'), new Uint8Array(Buffer.from(walletSeed, 'hex')));
  const privateState: VaultPrivateState = { secretKey: deployerSecretKey };
  const deployerCommitment = hash2x32(pad32('vault:user:'), deployerSecretKey);
  const deployedContract = await api.deploy(providers, privateState, mpcJubjubPk, deployerCommitment);
  const contractAddress = deployedContract.deployTxData.public.contractAddress;
  console.log(`Contract deployed at: ${contractAddress}\n`);

  // 4. Compute sepoliaVaultAddress from MPC PUBLIC key
  let sepoliaVaultAddress: Uint8Array;
  let sepoliaVaultAddressHex: string;
  if (SEPOLIA_VAULT_ADDRESS_HEX) {
    sepoliaVaultAddressHex = SEPOLIA_VAULT_ADDRESS_HEX;
    sepoliaVaultAddress = new Uint8Array(Buffer.from(SEPOLIA_VAULT_ADDRESS_HEX.replace('0x', ''), 'hex'));
  } else {
    sepoliaVaultAddressHex = deriveEvmAddress('0x' + MPC_PUBLIC_KEY_HEX!, contractAddress, 'vault');
    sepoliaVaultAddress = new Uint8Array(Buffer.from(sepoliaVaultAddressHex.replace('0x', ''), 'hex'));
    console.log(`Derived sepoliaVaultAddress (path="vault"): ${sepoliaVaultAddressHex}`);
    console.log(`  (derived from MPC public key, not private key)\n`);
  }

  // 5. Set the derived sepoliaVaultAddress (deployer-gated)
  console.log('Calling initialize(sepoliaVaultAddress)...');
  const initResult = await deployedContract.callTx.initialize(sepoliaVaultAddress);
  console.log(`initialize() confirmed: ${initResult.public.txHash}\n`);

  // 6. Verify
  const ledger = await api.getLedgerState(providers, contractAddress);
  if (!ledger || ledger.initialized !== 1n) {
    console.error('ERROR: Contract not initialized correctly');
    process.exit(1);
  }
  console.log('Contract initialized and verified.\n');

  // 7. Print env vars for the response server
  const zkConfigPath = path.resolve(currentDir, '..', '..', 'contract', 'src', 'managed', 'erc20-vault');
  const contractModulePath = path.resolve(zkConfigPath, 'contract', 'index.js');

  console.log('=== Add these to your response server .env ===\n');
  console.log(`MIDNIGHT_INDEXER_URL=${config.indexer}`);
  console.log(`MIDNIGHT_INDEXER_WS_URL=${config.indexerWS}`);
  console.log(`MIDNIGHT_NODE_URL=${config.node}`);
  console.log(`MIDNIGHT_PROOF_SERVER_URL=${config.proofServer}`);
  console.log(`MIDNIGHT_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(`# MPC_ROOT_KEY is set by the MPC operator (deployer already knows it)`);
  console.log(`MIDNIGHT_WALLET_SEED=${walletSeed}`);
  console.log(`MIDNIGHT_ZK_CONFIG_PATH=${zkConfigPath}`);
  console.log(`MIDNIGHT_CONTRACT_MODULE_PATH=${contractModulePath}`);
  console.log('');
  console.log(`# Sepolia addresses (derived from MPC public key):`);
  console.log(`# Vault receives ERC20: ${sepoliaVaultAddressHex}`);

  // Compute the E2E test user's derived Sepolia address.
  // The path is a 256-byte buffer with userCommitment in the first 32 bytes.
  const E2E_USER_SK = Buffer.from('22b8e577b3f638b2b361f36fd62d7138ed489d9afe3da5f7c325e2d0a95ae043', 'hex');
  const userCommitment = hash2x32(pad32('vault:user:'), E2E_USER_SK);
  const testPath = new Uint8Array(PATH_SIZE);
  testPath.set(userCommitment, 0);
  const testPathHex = Buffer.from(testPath).toString('hex');
  const userDerivedAddr = deriveEvmAddress('0x' + MPC_PUBLIC_KEY_HEX!, contractAddress, testPathHex);
  console.log(`# E2E test user commitment: ${Buffer.from(userCommitment).toString('hex')}`);
  console.log(`# E2E test derived address: ${userDerivedAddr}`);
  console.log(`#   → Fund this with USDC + Sepolia ETH for gas`);

  // Clean up
  await walletCtx.wallet.stop();
  console.log('\nDone! Copy the env vars above into your .env file.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
