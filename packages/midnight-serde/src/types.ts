// Type descriptors for Compact circuit types, the runtime mirror of what a
// contract declares at compile time. A descriptor tree fully determines the
// byte layout of Compact's builtin `serialize<T, N>` / `deserialize<T, N>`
// pair, so off-chain code can produce or consume the exact bytes a circuit
// reads or writes.

/**
 * The BLS12-381 scalar field modulus. A Compact `Field` value must be below
 * it. Matches `maxField + 1n` exported by @midnight-ntwrk/compact-runtime.
 */
export const FIELD_MODULUS =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

/** Maximum `Uint` width accepted by compactc 0.33 (bits). */
export const MAX_UINT_BITS = 248;

/** Compact `Boolean`: 1 byte, 0x00 or 0x01. */
export interface CompactBooleanType {
  readonly kind: 'boolean';
}

/** Compact `Uint<bits>`: ceil(bits / 8) bytes little-endian, bits 1..248. */
export interface CompactUintType {
  readonly kind: 'uint';
  readonly bits: number;
}

/** Compact `Field`: 32 bytes little-endian, value below {@link FIELD_MODULUS}. */
export interface CompactFieldType {
  readonly kind: 'field';
}

/** Compact `Bytes<length>`: raw bytes, copied verbatim. */
export interface CompactBytesType {
  readonly kind: 'bytes';
  readonly length: number;
}

/** Compact `Vector<length, element>`: elements back to back, no length prefix. */
export interface CompactVectorType {
  readonly kind: 'vector';
  readonly length: number;
  readonly element: CompactType;
}

/** A Compact struct: fields packed in declaration order, no gaps, flattened. */
export interface CompactStructType {
  readonly kind: 'struct';
  readonly fields: readonly { readonly name: string; readonly type: CompactType }[];
}

export type CompactType =
  | CompactBooleanType
  | CompactUintType
  | CompactFieldType
  | CompactBytesType
  | CompactVectorType
  | CompactStructType;

/**
 * The TypeScript value shapes descriptors map to, matching the generated
 * contract bindings: `Boolean` is boolean, `Uint`/`Field` are bigint,
 * `Bytes` is Uint8Array, `Vector` is an array, a struct is a plain object.
 */
export type CompactValue =
  | boolean
  | bigint
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
export type CompactValueOf<T extends CompactType> = T extends CompactBooleanType
  ? boolean
  : T extends CompactUintType | CompactFieldType
    ? bigint
    : T extends CompactBytesType
      ? Uint8Array
      : T extends CompactVectorType
        ? CompactValueOf<T['element']>[]
        : T extends CompactStructType
          ? {
              -readonly [F in T['fields'][number] as F['name']]: CompactValueOf<F['type']>;
            }
          : never;
