/**
 * Deploy and initialize the ERC20 vault contract for E2E testing with Sepolia.
 *
 * Uses the real MPC's public keys (Jubjub + secp256k1) to initialize the contract.
 * The vault address is derived from the MPC's secp256k1 public key + contract address.
 *
 * Usage:
 *   npx tsx src/deploy-for-e2e.ts
 *
 * Outputs the contract address and derived vault address for use in:
 *   - The MPC response server's MIDNIGHT_CONTRACT_ADDRESS env var
 *   - The E2E test's DEPLOYED_CONTRACT_ADDRESS constant
 *   - Funding the derived vault address on Sepolia
 */

import * as api from './api';
import { type VaultPrivateState } from './common-types';
import { getConfig } from './config';
import { createLogger } from './logger-utils';
import { hash2x32, pad32, deriveEvmAddress } from './crypto-utils';
import path from 'path';
import { currentDir } from './config';

const logDir = path.resolve(currentDir, '..', 'logs', 'deploy', `e2e-${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);
api.setLogger(logger);

// ---- MPC Jubjub Public Key ----
// Pass as env vars: MPC_JUBJUB_PK_X and MPC_JUBJUB_PK_Y (decimal bigint strings).
// Get these from the MPC server logs or by running: deriveJubjubKeypair(rootKey).pk

const pkX = process.env.MPC_JUBJUB_PK_X;
const pkY = process.env.MPC_JUBJUB_PK_Y;
if (!pkX || !pkY) throw new Error('MPC_JUBJUB_PK_X and MPC_JUBJUB_PK_Y env vars are required (decimal bigint strings)');
const MPC_JUBJUB_PK = { x: BigInt(pkX), y: BigInt(pkY) };
console.log(`MPC Jubjub PK: x=${MPC_JUBJUB_PK.x}, y=${MPC_JUBJUB_PK.y}`);

// MPC's secp256k1 compressed public key — for vault address derivation
const MPC_SECP256K1_PUBKEY = process.env.MPC_SECP256K1_PUBKEY || '0x024eef776e4f257d68983e45b340c2e9546c5df95447900b6aadfec68fb46fdee2';

// ---- Main ----

const WALLET_SEED = process.env.MIDNIGHT_WALLET_SEED || '0000000000000000000000000000000000000000000000000000000000000001';
const config = getConfig();

console.log('Building wallet...');
console.log(`Network: ${process.env.MIDNIGHT_NETWORK || 'standalone'}`);
const walletCtx = await api.buildWalletAndWaitForFunds(config, WALLET_SEED);
const providers = await api.configureProviders(walletCtx, config);

// Derive user secret key from wallet seed (one secret for the user)
const seedBytes = new Uint8Array(Buffer.from(WALLET_SEED, 'hex'));
const secretKey = hash2x32(pad32('vault:sk:'), seedBytes);
const privateState: VaultPrivateState = { secretKey };
const deployerCommitment = hash2x32(pad32('vault:user:'), secretKey);

console.log('Deploying contract...');
const deployedContract = await api.deploy(providers, privateState, MPC_JUBJUB_PK, deployerCommitment);
const contractAddress = deployedContract.deployTxData.public.contractAddress;
console.log(`Contract address: ${contractAddress}`);

// Derive vault address from MPC public key + contract address
const vaultAddress = deriveEvmAddress(MPC_SECP256K1_PUBKEY, contractAddress, 'vault');
const vaultAddressBytes = Buffer.from(vaultAddress.replace('0x', ''), 'hex');
console.log(`Derived vault address: ${vaultAddress}`);

// Set the derived vault address (deployer-gated)
console.log('Setting vault address...');
const initResult = await deployedContract.callTx.initialize(vaultAddressBytes);
console.log(`initialize() confirmed: ${initResult.public.txHash}`);

// Verify
const ledger = await api.getLedgerState(providers, contractAddress);
console.log(`initialized: ${ledger!.initialized}`);
console.log(`mpcPubKeyHash: ${Buffer.from(ledger!.mpcPubKeyHash).toString('hex')}`);
console.log(`sepoliaVaultAddress: 0x${Buffer.from(ledger!.sepoliaVaultAddress).toString('hex')}`);

// Derive user's Sepolia address (where the user must fund USDC before deposit).
// The derivation path is the lowercase hex of the user's identity commitment —
// the same string the contract stores (and verifies) in the path field, and that
// the MPC reads back as a plain string.
const commitmentHex = Buffer.from(deployerCommitment).toString('hex');
const userEvmAddress = deriveEvmAddress(MPC_SECP256K1_PUBKEY, contractAddress, commitmentHex);

console.log('\n=== E2E Setup Complete ===');
console.log(`MIDNIGHT_CONTRACT_ADDRESS=${contractAddress}`);
console.log(`SEPOLIA_VAULT_ADDRESS=${vaultAddress}`);
console.log(`USER_EVM_ADDRESS=${userEvmAddress}`);
console.log(`\nBefore running the E2E test:`);
console.log(`  1. Fund ${userEvmAddress} on Sepolia with ETH (gas) + USDC`);
console.log(`  2. Set MIDNIGHT_CONTRACT_ADDRESS=${contractAddress} in the MPC's .env`);
console.log(`  3. Start the MPC response server`);

await walletCtx.wallet.stop();
process.exit(0);
