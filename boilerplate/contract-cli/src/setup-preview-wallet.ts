/**
 * Prepare a fee-ready wallet on a hosted Midnight network (e.g. Preview), where nothing
 * endows the genesis seed. Prints the wallet's NIGHT address for the faucet, waits for the
 * NIGHT to arrive, registers it for dust generation, and confirms a spendable fee balance.
 *
 * Run (generates a fresh seed if none given — save the printed seed for the deploy):
 *   MIDNIGHT_NETWORK=preview npx tsx src/setup-preview-wallet.ts
 * or with your own seed:
 *   MIDNIGHT_NETWORK=preview MIDNIGHT_WALLET_SEED=<hex32> npx tsx src/setup-preview-wallet.ts
 */
import * as api from './api';
import { getConfig, currentDir } from './config';
import { createLogger } from './logger-utils';
import path from 'path';

const logDir = path.resolve(currentDir, '..', 'logs', 'setup-preview', `${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);
api.setLogger(logger);

const seed = process.env.MIDNIGHT_WALLET_SEED || Buffer.from(api.randomBytes(32)).toString('hex');
const network = process.env.MIDNIGHT_NETWORK || 'standalone';

console.log(`\nWallet seed — SAVE THIS, deploy with the same seed:\n  ${seed}\n`);
console.log(`Network: ${network}`);

const config = getConfig();
const ctx = await api.buildWallet(config, seed);
const address = ctx.unshieldedKeystore.getBech32Address();

console.log(`\nFund this address with tNIGHT, then watch it here:`);
console.log(`  faucet:   https://faucet.preview.midnight.network/`);
console.log(`  address:  ${address}`);
console.log(`  explorer: https://preview.midnightexplorer.com/\n`);
console.log('Waiting for NIGHT to arrive, then registering for dust generation...');

const dust = await api.registerWalletForDust(ctx);

console.log(`\nWallet is fee-ready. Dust (fee) balance: ${dust}`);
console.log(`\nNow deploy with:\n  MIDNIGHT_NETWORK=${network} MIDNIGHT_WALLET_SEED=${seed} \\`);
console.log(`    MPC_JUBJUB_PK_X=<same> MPC_JUBJUB_PK_Y=<same> MPC_SECP256K1_PUBKEY=<same> npx tsx src/deploy-for-e2e.ts\n`);

await ctx.wallet.stop();
process.exit(0);
