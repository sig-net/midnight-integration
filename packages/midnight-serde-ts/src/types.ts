// Type descriptors for Compact circuit types, the runtime mirror of what a
// contract declares at compile time. A descriptor tree fully determines the
// byte layout of Compact's builtin `serialize<T, N>` / `deserialize<T, N>`
// pair, so off-chain code can produce or consume the exact bytes a circuit
// reads or writes.
//
// Coverage: every serializable Compact type has a descriptor kind. The only
// exclusion is `Opaque<...>`, which compactc itself rejects with
// "Opaque<...> is not a serializable type".

/**
 * The BLS12-381 scalar field modulus. A Compact `Field` value must be below
 * it. Matches `maxField + 1n` exported by @midnight-ntwrk/compact-runtime.
 */
export const FIELD_MODULUS =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

/** Maximum `Uint` width accepted by compactc 0.33 (bits). */
export const MAX_UINT_BITS = 248;

/**
 * Maximum EXCLUSIVE bound of a Compact `Uint<0..n>`: 2^248, i.e. one above
 * the language reference's maximum Uint value 256^31 - 1.
 */
export const MAX_UINT_BOUND = 1n << 248n;

/** Compact `Boolean`: 1 byte, 0x00 or 0x01. */
export interface CompactBooleanType {
  readonly kind: 'boolean';
}

/** Compact `Uint<bits>` (sized): ceil(bits / 8) bytes little-endian, bits 1..248. */
export interface CompactSizedUintType {
  readonly kind: 'uint';
  readonly bits: number;
}

/**
 * Compact `Uint<0..bound>` (bounded): values 0 (inclusive) to `bound`
 * EXCLUSIVE, per the language reference. Width is the byte length of
 * `bound - 1`, so `Uint<0..1000>` is 2 bytes and `Uint<0..1>` is ZERO bytes
 * (both circuit-pinned). A number `bound` must be a safe integer; use a
 * bigint beyond 2^53.
 */
export interface CompactBoundedUintType {
  readonly kind: 'uint';
  readonly bound: number | bigint;
}

/**
 * A Compact unsigned integer, in either declaration form. `Uint<w>` is the
 * same type as `Uint<0..2^w>`, so `{ bits: w }` and `{ bound: 1n << w }`
 * describe identical layouts and ranges.
 */
export type CompactUintType = CompactSizedUintType | CompactBoundedUintType;

/** Compact `Field`: 32 bytes little-endian, value below {@link FIELD_MODULUS}. */
export interface CompactFieldType {
  readonly kind: 'field';
}

/** Compact `Bytes<length>`: raw bytes, copied verbatim. `Bytes<0>` is legal. */
export interface CompactBytesType {
  readonly kind: 'bytes';
  readonly length: number;
}

/**
 * A Compact enum: the variant INDEX packed exactly like
 * `Uint<0..variants>`, i.e. byte length of `variants - 1` (one byte up to
 * 256 variants, ZERO bytes for a single-variant enum; circuit-pinned).
 * Values are numbers, matching the generated contract bindings.
 */
export interface CompactEnumType {
  readonly kind: 'enum';
  readonly variants: number;
}

/**
 * Compact `Vector<length, element>`: elements back to back, no length
 * prefix. `Vector<0, T>` is legal and zero bytes wide.
 */
export interface CompactVectorType {
  readonly kind: 'vector';
  readonly length: number;
  readonly element: CompactType;
}

/**
 * A Compact tuple `[T1, ..., Tn]`: elements packed in order, no gaps, no
 * prefix, exactly like a struct without field names. `Vector<n, T>` is the
 * homogeneous special case. Values are TypeScript arrays/tuples, matching
 * the generated contract bindings. The empty tuple `[]` is legal and zero
 * bytes wide.
 */
export interface CompactTupleType {
  readonly kind: 'tuple';
  readonly elements: readonly CompactType[];
}

/**
 * A Compact struct: fields packed in declaration order, no gaps, flattened.
 * A struct with no fields is legal and zero bytes wide.
 */
export interface CompactStructType {
  readonly kind: 'struct';
  readonly fields: readonly { readonly name: string; readonly type: CompactType }[];
}

export type CompactType =
  | CompactBooleanType
  | CompactUintType
  | CompactFieldType
  | CompactBytesType
  | CompactEnumType
  | CompactVectorType
  | CompactTupleType
  | CompactStructType;

/**
 * The TypeScript value shapes descriptors map to, matching the generated
 * contract bindings: `Boolean` is boolean, `Uint`/`Field` are bigint, an
 * enum is a number (the variant index), `Bytes` is Uint8Array, `Vector` and
 * tuples are arrays, a struct is a plain object.
 */
export type CompactValue =
  | boolean
  | bigint
  | number
  | Uint8Array
  | CompactValue[]
  | { [field: string]: CompactValue };

/**
 * The precise TypeScript value type of a descriptor. Declare descriptors
 * `as const satisfies CompactType` (or as a plain literal) and both
 * `compactSerialize` and `compactDeserialize` type their values exactly:
 *
 * ```ts
 * const RESULT = {
 *   kind: "struct",
 *   fields: [
 *     { name: "ok", type: { kind: "boolean" } },
 *     { name: "amount", type: { kind: "uint", bits: 128 } },
 *   ],
 * } as const satisfies CompactType;
 *
 * const value = compactDeserialize(RESULT, bytes);
 * //    ^? { ok: boolean; amount: bigint }
 * ```
 *
 * A descriptor WIDENED to `CompactType` degrades gracefully to
 * {@link CompactValue}.
 */
/**
 * Maps a tuple of descriptors to the tuple of their value types. A separate
 * alias with its own type parameter so the mapped type is homomorphic (an
 * inline `keyof T['elements']` would map method keys too, not just indices).
 */
type CompactTupleValueOf<E extends readonly CompactType[]> = number extends E['length']
  ? CompactValue[] // widened to an arbitrary-length array: degrade gracefully
  : { -readonly [I in keyof E]: CompactValueOf<E[I]> };

export type CompactValueOf<T extends CompactType> = T extends CompactBooleanType
  ? boolean
  : T extends CompactUintType | CompactFieldType
    ? bigint
    : T extends CompactEnumType
      ? number
      : T extends CompactBytesType
        ? Uint8Array
        : T extends CompactVectorType
          ? CompactValueOf<T['element']>[]
          : T extends CompactTupleType
            ? CompactTupleValueOf<T['elements']>
            : T extends CompactStructType
              ? {
                  -readonly [F in T['fields'][number] as F['name']]: CompactValueOf<F['type']>;
                }
              : never;
