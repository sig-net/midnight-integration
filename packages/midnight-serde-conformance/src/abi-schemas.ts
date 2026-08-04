// The respond-schema fixture cases behind the corpus's `schema` records: the
// ABI-style JSON schemas carried on chain in SignBidirectionalEvent
// (outputDeserializationSchema / respondSerializationSchema, see
// signet-midnight's Signet.compact), paired with values in BOTH forms the
// protocol handles:
//
//   abiValue      the decoded-EVM-output form serializeRespondOutput accepts
//   compactValue  the Compact-level form under the schema's derived descriptor
//
// The generator drives the REAL production mapping (@sig-net/midnight's
// respondSchemaDescriptor + serializeRespondOutput) over these and asserts it
// agrees with the serde twin byte for byte, so the corpus pins the whole
// pipeline: schema JSON -> descriptor -> bytes. The first two schema strings
// are VERBATIM the literals test-caller-contract.compact carries on chain.

import type { AbiDecodedOutput } from "@sig-net/midnight";
import type { CompactValue } from "@sig-net/midnight-serde";

/** One respond-schema corpus case. */
export interface SchemaCase {
  /** Stable corpus slug. */
  name: string;
  /** The schema EXACTLY as carried on chain (NUL padding included, if any). */
  schema: string;
  /** The decoded-output form fed to the production serializeRespondOutput. */
  abiValue: AbiDecodedOutput;
  /** The same value in Compact form under the schema's derived descriptor. */
  compactValue: CompactValue;
}

/** "hi signet" zero-padded into a Bytes<32> capacity buffer. */
const MSG_DATA = (() => {
  const data = new Uint8Array(32);
  data.set(new TextEncoder().encode("hi signet"));
  return data;
})();

/** 0xdeadbeef zero-padded into a Bytes<16> capacity buffer. */
const RAW_DATA = (() => {
  const data = new Uint8Array(16);
  data.set(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
  return data;
})();

/**
 * Every schema case in the corpus. The exact-width single-bool and
 * bool+uint256 schemas are byte-identical to the `as Bytes<34>` / `as
 * Bytes<69>` literals in test-caller-contract.compact. The rest sweep the
 * respond vocabulary (whole-byte uints, uint256/address as Field carriers,
 * bytesN, dynamic string/bytes with maxBytes, arrays with maxItems, and the
 * NUL-padded on-chain form).
 */
export const SCHEMA_CASES: SchemaCase[] = [
  {
    name: 'schema-bool',
    schema: '[{"name":"success","type":"bool"}]',
    abiValue: { success: true },
    compactValue: { success: true },
  },
  {
    name: 'schema-bool-uint256',
    schema: '[{"name":"success","type":"bool"},{"name":"amount","type":"uint256"}]',
    abiValue: { success: true, amount: (1n << 200n) + 12345n },
    compactValue: { success: true, amount: (1n << 200n) + 12345n },
  },
  {
    name: 'schema-fixed-widths',
    schema:
      '[{"name":"who","type":"address"},{"name":"tag","type":"bytes32"},{"name":"n","type":"uint128"}]',
    abiValue: {
      who: (1n << 160n) - 1n,
      tag: new Uint8Array(32).fill(0xab),
      n: (1n << 128n) - 1n,
    },
    compactValue: {
      who: (1n << 160n) - 1n,
      tag: new Uint8Array(32).fill(0xab),
      n: (1n << 128n) - 1n,
    },
  },
  {
    name: 'schema-dynamic',
    schema:
      '[{"name":"msg","type":"string","maxBytes":32},{"name":"raw","type":"bytes","maxBytes":16}]',
    abiValue: { msg: 'hi signet', raw: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) },
    compactValue: {
      msg: { len: 9n, data: MSG_DATA },
      raw: { len: 4n, data: RAW_DATA },
    },
  },
  {
    name: 'schema-array',
    schema: '[{"name":"vals","type":"uint64[]","maxItems":3}]',
    abiValue: { vals: [7n, 8n] },
    compactValue: { vals: { len: 2n, items: [7n, 8n, 0n] } },
  },
  {
    // The NUL-padded on-chain form: fixed-width Bytes<N> wider than the
    // schema text. Consumers must cut at the first NUL before JSON-parsing.
    name: 'schema-bool-nul-padded',
    schema: '[{"name":"success","type":"bool"}]' + '\u0000'.repeat(30),
    abiValue: { success: false },
    compactValue: { success: false },
  },
];
