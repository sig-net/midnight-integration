// Protocol constants shared by the setup steps and the flow files: values
// fixed by the contracts under test, kept in one place so the TS twins
// cannot drift apart.

import { asciiPadded, bytesToHex } from "@sig-net/midnight";

/**
 * The caller contract's fixed derivation path as the ledger stores it:
 * every submit circuit sets the record's `path` to `pad(32, "caller-path")`,
 * so ONE derived EVM sender serves all requests. TS twin of the in-circuit
 * literal.
 */
export const CALLER_PATH_BYTES = asciiPadded("caller-path", 32);

/**
 * The derivation-string rendering of {@link CALLER_PATH_BYTES}: the MPC
 * renders a record's path as the lowercase hex of the full 32 bytes,
 * padding included, and `deriveEvmAddress` takes the same rendering.
 */
export const CALLER_PATH_HEX = bytesToHex(CALLER_PATH_BYTES);
