// Neither contract declares witnesses (no private state): the token just
// counts deposits and emits, the vault just forwards the call. Both still need
// an (empty) private-state value + a witnesses object to bind via
// makeVacantCompiledContract, mirroring signet-contract's witness-less setup.

import type { Witnesses as TokenWitnesses } from "./managed/Token/contract/index.js";
import type { Witnesses as VaultWitnesses } from "./managed/vault/contract/index.js";

/** Private state carried through token circuit calls: none. */
export type TokenPrivateState = Record<string, never>;
/** Private state carried through vault circuit calls: none. */
export type VaultPrivateState = Record<string, never>;

export const createTokenPrivateState = (): TokenPrivateState => ({});
export const createVaultPrivateState = (): VaultPrivateState => ({});

export const tokenWitnesses: TokenWitnesses<TokenPrivateState> = {};
export const vaultWitnesses: VaultWitnesses<VaultPrivateState> = {};
