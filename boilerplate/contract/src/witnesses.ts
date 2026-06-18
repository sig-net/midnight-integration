import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WitnessContext } from '@midnight-ntwrk/compact-runtime';

// Get __dirname in ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get the only folder inside ./managed
const managedPath = path.join(__dirname, 'managed');
const [folder] = fs.readdirSync(managedPath).filter(f =>
  fs.statSync(path.join(managedPath, f)).isDirectory()
);

// Dynamically import the contract
const { Ledger } = await import(`./managed/${folder}/contract/index.js`);

/**
 * Private state for the ERC20 vault contract.
 *
 * Contains the user's secret key (used for identity commitment in deposit/claim).
 * MPC authentication is now via Schnorr signature — no secret witness needed.
 */
export type VaultPrivateState = {
  readonly secretKey: Uint8Array;
};

export const createVaultPrivateState = (secretKey: Uint8Array): VaultPrivateState => ({
  secretKey,
});

const TWO_248 = 452312848583266388373324160190187140051835877600158453279131187530910662656n;

export const witnesses = {
  /**
   * Caller witness: provides the caller's secret key.
   * The circuit hashes this into a commitment for on-chain storage (bboard pattern).
   * The commitment also serves as the MPC derivation path.
   */
  callerSecretKey: ({ privateState }: WitnessContext<typeof Ledger, VaultPrivateState>): [VaultPrivateState, Uint8Array] => {
    return [privateState, privateState.secretKey];
  },

  /**
   * Schnorr challenge reduction witness (required by the `schnorr` module).
   * Returns (quotient, remainder) of dividing the challenge hash by 2^248 so
   * the circuit can truncate it into Jubjub's scalar field.
   */
  getSchnorrReduction: (
    { privateState }: WitnessContext<typeof Ledger, VaultPrivateState>,
    challengeHash: bigint,
  ): [VaultPrivateState, [bigint, bigint]] => {
    const q = challengeHash / TWO_248;
    const r = challengeHash % TWO_248;
    return [privateState, [q, r]];
  },
};
