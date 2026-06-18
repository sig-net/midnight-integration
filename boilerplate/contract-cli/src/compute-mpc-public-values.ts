/**
 * MPC Operator Utility: Compute public values from the MPC secret.
 *
 * Usage:
 *   MPC_SECRET=0x<64hex> npx tsx src/compute-mpc-public-values.ts
 *
 * Outputs:
 *   - MPC_COMMITMENT: hash(["mpc:auth:", secret]) — share with deployers
 *   - MPC_PUBLIC_KEY: 65-byte uncompressed secp256k1 public key — share with deployers
 *
 * The MPC operator runs this once, then shares the two values with anyone
 * who needs to deploy a vault contract. The secret never leaves this machine.
 */

import * as ecc from 'tiny-secp256k1';
import { pad32, hash2x32 } from './crypto-utils';

const MPC_SECRET_HEX = process.env.MPC_SECRET;
if (!MPC_SECRET_HEX || !/^0x[a-fA-F0-9]{64}$/.test(MPC_SECRET_HEX)) {
  console.error('Usage: MPC_SECRET=0x<64-hex-chars> npx tsx src/compute-mpc-public-values.ts');
  process.exit(1);
}

const secretBytes = Buffer.from(MPC_SECRET_HEX.replace('0x', ''), 'hex');

// Compute commitment: persistentHash(["mpc:auth:", secret])
const mpcCommitment = hash2x32(pad32('mpc:auth:'), new Uint8Array(secretBytes));

// Compute public key from secret
const mpcPublicKey = ecc.pointFromScalar(secretBytes, false); // uncompressed, 65 bytes
if (!mpcPublicKey) {
  console.error('ERROR: Failed to derive public key from secret');
  process.exit(1);
}

console.log('=== MPC Public Values ===\n');
console.log('Share these with contract deployers. The secret stays on the MPC server.\n');
console.log(`MPC_COMMITMENT=${Buffer.from(mpcCommitment).toString('hex')}`);
console.log(`MPC_PUBLIC_KEY=${Buffer.from(mpcPublicKey).toString('hex')}`);
