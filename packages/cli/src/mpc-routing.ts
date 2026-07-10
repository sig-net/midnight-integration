// The CONTRACT-FIXED MPC routing of every vault signature request — TS
// mirror of the vault contract's in-circuit `vaultMpcRouting()` constants,
// needed to rebuild expected request records off-chain. MUST stay in
// lockstep with erc20-vault.compact; the vault package's round-trip
// simulator tests assert the same values against the real compiled contract.

import {
  ALGO_BYTES,
  asciiPadded,
  DEST_BYTES,
  MPC_PARAMS_BYTES,
  OUTPUT_DESERIALIZATION_SCHEMA_BYTES,
  RESPOND_SERIALIZATION_SCHEMA_BYTES,
  SIGNET_ALGO_ECDSA,
  SIGNET_DEST_ETHEREUM,
} from "@midnight-erc20-vault/signet-midnight";

/**
 * What the MPC reports back about the EVM call: an ERC20 `transfer` returns
 * a single bool. Serves as both the output-deserialization and the
 * respond-serialization schema of the vault's requests.
 */
export const ERC20_TRANSFER_RESULT_SCHEMA = '[{"name":"success","type":"bool"}]';

/**
 * The contract-fixed routing fields of a vault request. Field names match
 * `SignBidirectionalRequest`, so an expected request record can spread a
 * value of this type directly.
 */
export interface VaultMpcRouting {
  /** Signature scheme ("ecdsa"), zero-padded ASCII; 32 bytes. */
  readonly algo: Uint8Array;
  /** Response destination ("ethereum"), zero-padded ASCII; 32 bytes. */
  readonly dest: Uint8Array;
  /** Scheme-specific extras (unused, zeroed); 64 bytes. */
  readonly params: Uint8Array;
  /** MPC output_deserialization_schema; 128 bytes. */
  readonly outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema; 128 bytes. */
  readonly respondSerializationSchema: Uint8Array;
}

/**
 * The routing the vault contract bakes into every request it records: ECDSA
 * over an EVM ("ethereum") destination, no extras, and the ERC20 `transfer`
 * bool result schema in both directions.
 */
export const VAULT_MPC_ROUTING: VaultMpcRouting = {
  algo: asciiPadded(SIGNET_ALGO_ECDSA, ALGO_BYTES),
  dest: asciiPadded(SIGNET_DEST_ETHEREUM, DEST_BYTES),
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(ERC20_TRANSFER_RESULT_SCHEMA, OUTPUT_DESERIALIZATION_SCHEMA_BYTES),
  respondSerializationSchema: asciiPadded(ERC20_TRANSFER_RESULT_SCHEMA, RESPOND_SERIALIZATION_SCHEMA_BYTES),
};
