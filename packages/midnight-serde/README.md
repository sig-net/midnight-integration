# @sig-net/midnight-serde

TypeScript twin of Compact's builtin `serialize<T, N>` / `deserialize<T, N>`
pair (CompactStandardLibrary). Produce bytes off-chain that a contract reads
with one `deserialize<T, N>` call, and decode bytes a contract produced with
`serialize<T, N>`. Zero runtime dependencies.

Every claim is pinned byte-for-byte against COMPILED circuits: the fixture
contract in [`tests/fixtures/serde-fixtures.compact`](tests/fixtures/serde-fixtures.compact)
wraps the builtins over structs exercising all supported types and combos, and
the tests assert twin/circuit equality in both directions. A second,
independent oracle backs the serialize direction: `toBinaryRepr` from
`@midnight-ntwrk/compact-runtime` (test-only, never a runtime dependency)
must agree with the twin on every shape, including the shapes compactc cannot
compile `serialize<T, N>` for.

## Use

Describe the Compact type as a descriptor tree, then encode/decode values.
Declare descriptors `as const satisfies CompactType` and the value types are
INFERRED from the descriptor (`CompactValueOf<T>`), both in and out, so no
casts and no hand-written interfaces:

```ts
import { compactSerialize, compactDeserialize, type CompactType } from "@sig-net/midnight-serde";

// Compact: struct Result { ok: Boolean; amount: Uint<128>; }
const RESULT = {
  kind: "struct",
  fields: [
    { name: "ok", type: { kind: "boolean" } },
    { name: "amount", type: { kind: "uint", bits: 128 } },
  ],
} as const satisfies CompactType;

// serialize<Result, 128> twin: packed value at the start, zero-padded to 128.
// The value parameter is compile-time checked against the descriptor.
const bytes = compactSerialize(RESULT, { ok: true, amount: 4242n }, 128);

// deserialize<Result, 128> twin.
const value = compactDeserialize(RESULT, bytes);
//    ^? { ok: boolean; amount: bigint }
```

A descriptor widened to `CompactType` still works and degrades to the loose
`CompactValue` union.

## Types and layout

Fields and elements pack in declaration order, little-endian, natural widths,
no gaps, no length prefixes. Every serializable Compact type has a descriptor
kind (`Opaque<...>` is the one exclusion: compactc itself rejects it as "not
a serializable type"):

| Compact type | Descriptor | Packed width | Value type |
| --- | --- | --- | --- |
| `Boolean` | `{ kind: 'boolean' }` | 1 byte (0x00/0x01) | `boolean` |
| `Uint<w>` (sized) | `{ kind: 'uint', bits: w }` | ceil(w / 8), w at most 248 | `bigint` |
| `Uint<0..n>` (bounded) | `{ kind: 'uint', bound: n }` | byte length of n - 1 | `bigint` |
| `Field` | `{ kind: 'field' }` | 32 bytes, value below the Fr modulus | `bigint` |
| `Bytes<n>` | `{ kind: 'bytes', length: n }` | n, raw | `Uint8Array` |
| enum | `{ kind: 'enum', variants: k }` | byte length of k - 1 | `number` (index) |
| `Vector<n, T>` | `{ kind: 'vector', length: n, element }` | n elements, unprefixed | `T[]` |
| `[T1, ..., Tn]` (tuple) | `{ kind: 'tuple', elements }` | elements back to back | TS tuple |
| struct | `{ kind: 'struct', fields }` | fields back to back | plain object |

The `Uint<0..n>` upper bound is EXCLUSIVE, per the language reference: the
values are 0 to n - 1, so `Uint<0..1000>` is 2 bytes and `Uint<8>` is the same
type as `Uint<0..256>`. An enum is `Uint<0..variants>` under the hood. That
width rule makes some legal types ZERO bytes wide: `Uint<0..1>`,
single-variant enums, `Bytes<0>`, `Vector<0, T>`, the empty tuple and the
empty struct all occupy no space (circuit-pinned).

`serialize<T, N>` places the packed value at the start of `Bytes<N>` and
zero-pads on the right. N below the packed size is a compile error in Compact
and a thrown error here.

## Divergences from the circuit

Both are strict-by-default on DECODE, and both are pinned by tests. Bytes a
circuit produced never trigger either one, since `serialize<T, N>` only ever
writes zero padding and 0x00/0x01 booleans:

- **Padding:** the circuit ignores bytes in the padding region entirely, the
  twin rejects non-zero padding. Pass `{ ignorePadding: true }` to
  `compactDeserialize` to mirror the circuit exactly.
- **Booleans:** the circuit decodes ANY byte other than 0x01 as `false`
  (0x02..0xff included), the twin rejects bytes above 1.

Everything else mirrors the circuit exactly, including rejections:
out-of-range bounded Uint, enum and Field encodings throw in-circuit and
throw here (all pinned by the tests).

Known compactc 0.33 limits (pinned by the tests): `serialize<T, N>` crashes
the COMPILER on vectors of structs, vectors of vectors, and struct nesting
deeper than one level. `deserialize<T, N>` handles all of those, so contracts
can still READ such payloads from off-chain encoders. Tuples are unaffected:
`serialize<[Pair, Boolean], N>` compiles fine.

## Develop

```bash
yarn compile   # compile the fixture contract (needed before test/build)
yarn test      # pin the twin against the compiled circuits + toBinaryRepr
yarn build     # typecheck + emit ./dist for publishing
```
