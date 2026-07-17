// Derive the MPC public keys from MPC_ROOT_KEY — the values deploy-for-e2e.ts needs.
// Usage:  MPC_ROOT_KEY=0x<64 hex> npx tsx src/derive-mpc-keys.ts
import { ethers } from 'ethers';
import { deriveJubjubKeypair } from './signet/schnorr';

const root = (process.env.MPC_ROOT_KEY || '').replace(/^0x/, '');
if (root.length !== 64) {
  throw new Error('Set MPC_ROOT_KEY to a 32-byte hex string (64 hex chars, 0x optional)');
}
const rootBytes = new Uint8Array(Buffer.from(root, 'hex'));
const { pk } = deriveJubjubKeypair(rootBytes);   // same call the MPC server makes
const secp = new ethers.SigningKey('0x' + root);

console.log('MPC_JUBJUB_PK_X=' + pk.x.toString());
console.log('MPC_JUBJUB_PK_Y=' + pk.y.toString());
console.log('MPC_SECP256K1_PUBKEY=' + secp.compressedPublicKey);
