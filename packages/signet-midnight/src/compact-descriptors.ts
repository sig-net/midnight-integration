// Compact-generic runtime descriptor toolkit: compact-runtime `CompactType`
// codecs (alignment/toValue/fromValue) at the same literals the compiler
// emits, composed into the signet record descriptors by the request modules.
// They exist so the package can (a) decode raw state cells of ANY requester
// contract discovered at runtime and (b) serialize a record byte-identically
// to the circuits' keccak256 preimage, and they exist HERE only because the
// Midnight libraries expose no supported equivalent:
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
// Delete each piece of this file the moment compact-runtime exports a
// supported equivalent.
//
// These are NOT the `CompactType` schema types of @sig-net/midnight-serde
// (that package describes the `serialize<T, N>` wire format, a different
// layer). Package-internal: consumers use the reader/request functions built
// on top, never these directly.

import {
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  type CompactType,
} from "@midnight-ntwrk/compact-runtime";

// Runtime descriptors of the Compact base types, at the same literals the
// compiler emits.
export const BYTES_4 = new CompactTypeBytes(4);
export const BYTES_20 = new CompactTypeBytes(20);
export const BYTES_32 = new CompactTypeBytes(32);
export const BYTES_64 = new CompactTypeBytes(64);
export const UINT_8 = new CompactTypeUnsignedInteger(2n ** 8n - 1n, 1);
export const UINT_16 = new CompactTypeUnsignedInteger(2n ** 16n - 1n, 2);
export const UINT_64 = new CompactTypeUnsignedInteger(2n ** 64n - 1n, 8);
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
  const entries = Object.entries(fields) as unknown as ReadonlyArray<
    [keyof T & string, CompactType<T[keyof T & string]>]
  >;
  return {
    alignment: () =>
      entries.flatMap(([, type]) => type.alignment()),
    toValue: (value) =>
      entries.flatMap(([key, type]) => type.toValue(value[key])),
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
