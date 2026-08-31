// Compact-generic runtime descriptor toolkit: compact-runtime `CompactType`
// codecs (alignment/toValue/fromValue) at the same literals the compiler
// emits, composed into the signet record descriptors by the request modules.
// These are required so that packages can
//   - decode raw state cells processed at runtime into types used by the protocol,
//     without requiring access to the compactc generated contract specific SDK.
//   - present a record to `transientHash` with the same alignment the circuits hash
//     it under
// These descriptors are required as Midnight libraries expose no supported equivalent:
//  - A compiled contract module (`src/managed/`) builds one such codec per
//    ledger type but keeps them module-private, exporting only `ledger()`,
//    which decodes the FULL state of the one contract it was compiled from.
//    Signet readers hold neither that contract's compiled module nor its
//    full state: just a cell.
//  - `@midnight-ntwrk/compact-runtime` exports the primitive codec classes
//    (`CompactTypeBytes`, `CompactTypeUnsignedInteger`, ...) but no struct
//    composer and no `Maybe` descriptor, and documents its own pre-built
//    instances (`Bytes32Descriptor`, `ContractAddressDescriptor`, ...) as
//    "not intended for direct consumption".
//
// Delete each piece of this file the moment compact-runtime exports a
// supported equivalent.
//
// These are NOT the `CompactType` schema types of @sig-net/midnight-serde
// (that package describes the `serialize<T, N>` wire format, a different
// layer). Package-internal: consumers use the reader/request functions built
// on top, never these directly.

import {
  type AlignedValue,
  type CompactType,
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
} from "@midnight-ntwrk/compact-runtime";

// Runtime descriptors of the Compact base types, at the same literals the
// compiler emits.

/** Descriptor of a Compact `Bytes<4>`. */
export const BYTES_4 = new CompactTypeBytes(4);
/** Descriptor of a Compact `Bytes<20>`. */
export const BYTES_20 = new CompactTypeBytes(20);
/** Descriptor of a Compact `Bytes<32>`. */
export const BYTES_32 = new CompactTypeBytes(32);
/** Descriptor of a Compact `Bytes<64>`. */
export const BYTES_64 = new CompactTypeBytes(64);
/** Descriptor of a Compact `Uint<8>`. */
export const UINT_8 = new CompactTypeUnsignedInteger(2n ** 8n - 1n, 1);
/** Descriptor of a Compact `Uint<16>`. */
export const UINT_16 = new CompactTypeUnsignedInteger(2n ** 16n - 1n, 2);
/** Descriptor of a Compact `Uint<64>`. */
export const UINT_64 = new CompactTypeUnsignedInteger(2n ** 64n - 1n, 8);
/** Descriptor of a Compact `Uint<128>`. */
export const UINT_128 = new CompactTypeUnsignedInteger(2n ** 128n - 1n, 16);

/**
 * A Midnight contract address as the generated code represents it in struct
 * fields (Compact `ContractAddress`): a single-field wrapper around the raw
 * 32 address bytes.
 */
export interface ContractAddress {
  bytes: Uint8Array;
}

/**
 * Descriptor of a Compact `ContractAddress` struct field: a single-field
 * `{ bytes: Bytes<32> }` wrapper, exactly as the compiler generates it.
 */
export const CONTRACT_ADDRESS: CompactType<ContractAddress> = {
  alignment: () => BYTES_32.alignment(),
  fromValue: (value) => ({ bytes: BYTES_32.fromValue(value) }),
  toValue: (value) => BYTES_32.toValue(value.bytes),
};

/**
 * Compact's standard-library `Maybe<T>` as the compiler generates it: a
 * plain struct. Even when `is_some` is false, `value` carries a full
 * default-valued `T` (so vector capacities remain inferable).
 */
export interface Maybe<T> {
  is_some: boolean;
  value: T;
}

/**
 * Build the runtime descriptor of a Compact struct from its per-field
 * descriptors. Field ORDER is the encoding order and must match the Compact
 * struct declaration order: object literals preserve insertion order for
 * string keys, so pass fields in declaration order.
 *
 * @param fields - One runtime descriptor per struct field, in declaration order.
 * @returns The composed struct descriptor.
 */
export function compactStructDescriptor<T extends object>(fields: {
  readonly [K in keyof T]-?: CompactType<T[K]>;
}): CompactType<T> {
  const entries = Object.entries(fields) as unknown as readonly [
    keyof T & string,
    CompactType<T[keyof T & string]>,
  ][];
  return {
    alignment: () => entries.flatMap(([, type]) => type.alignment()),
    toValue: (value) => entries.flatMap(([key, type]) => type.toValue(value[key])),
    fromValue: (value) => {
      const result = {} as Record<keyof T & string, unknown>;
      for (const [key, type] of entries) {
        result[key] = type.fromValue(value);
      }
      return result as T;
    },
  };
}

/**
 * Descriptor of Compact's standard-library `Maybe<T>`: the compiler
 * generates it as the struct `{ is_some: Boolean, value: T }`.
 *
 * @param inner - Descriptor of the wrapped type.
 * @returns The Maybe struct descriptor.
 */
export function compactMaybeDescriptor<T>(inner: CompactType<T>): CompactType<Maybe<T>> {
  return compactStructDescriptor<Maybe<T>>({
    is_some: CompactTypeBoolean,
    value: inner,
  });
}

/**
 * Decode ONE whole stored value with a descriptor. `fromValue` is a cursor:
 * it consumes atoms from the front of the array it is handed and ignores
 * whatever remains, which is right for descriptors chained mid-struct but
 * wrong for a complete key, cell or payload: called directly it either
 * mutates live state (no copy) or accepts trailing atoms the descriptor
 * never read (copy, no length check). This wrapper owns the copy and rejects
 * leftovers, so a stored shape that has outgrown its descriptor fails loudly
 * instead of decoding a stale prefix.
 *
 * @param type - The descriptor to decode with.
 * @param atoms - The complete stored value. Never mutated.
 * @param what - Error-message subject.
 * @returns The decoded value.
 * @throws {Error} If the descriptor rejects the atoms, or atoms remain after
 *   it has consumed its fill.
 */
export function decodeExactly<T>(
  type: CompactType<T>,
  atoms: readonly Uint8Array[],
  what: string,
): T {
  const cursor = [...atoms];
  const decoded = type.fromValue(cursor);
  if (cursor.length !== 0) {
    throw new Error(
      `${what} decode left ${String(cursor.length)} of ${String(atoms.length)} atoms unconsumed`,
    );
  }
  return decoded;
}

/**
 * The declared width of each atom. Signet declares only `Bytes` atoms, so a
 * widthless or nested segment is refused rather than assigned a width.
 *
 * @param cell - The record cell as stored.
 * @param what - Error-message subject.
 * @returns One declared byte width per atom.
 * @throws {Error} If the alignment and value lengths disagree or a segment is
 *   not a `Bytes` atom.
 */
export function declaredWidths(cell: AlignedValue, what: string): number[] {
  if (cell.alignment.length !== cell.value.length) {
    throw new Error(
      `${what} declares ${String(cell.alignment.length)} alignment segments for ` +
        `${String(cell.value.length)} atoms`,
    );
  }
  return cell.alignment.map((segment, index) => {
    if (segment.tag !== "atom") {
      throw new Error(
        `${what} atom ${String(index)} is an alignment option, which no signet type declares`,
      );
    }
    if (segment.value.tag !== "bytes") {
      throw new Error(
        `${what} atom ${String(index)} is aligned '${segment.value.tag}', which carries no byte width`,
      );
    }
    return segment.value.length;
  });
}

/**
 * Descriptor of the Compact tuple `[RequestId, Bytes<serializedOutputLength>]`
 * the attestation digest hashes, composed the way the compiler composes a
 * tuple: the elements' alignments and values concatenated in order. The output
 * width enters the descriptor, so it is fixed per call rather than a constant.
 *
 * @param serializedOutputLength - Declared width of the output element, in bytes.
 * @returns The pair descriptor for {@link calculateSignetAttestationDigest}.
 */
export function attestationPreimageDescriptor(
  serializedOutputLength: number,
): CompactType<[Uint8Array, Uint8Array]> {
  const output = new CompactTypeBytes(serializedOutputLength);
  return {
    alignment: () => [...BYTES_32.alignment(), ...output.alignment()],
    toValue: ([requestId, serializedOutput]) => [
      ...BYTES_32.toValue(requestId),
      ...output.toValue(serializedOutput),
    ],
    fromValue: (value) => [BYTES_32.fromValue(value), output.fromValue(value)],
  };
}
