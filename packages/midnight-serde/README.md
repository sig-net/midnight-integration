# @sig-net/midnight-serde

TypeScript twin of Compact's builtin `serialize<T, N>` / `deserialize<T, N>`
pair (CompactStandardLibrary). Produce bytes off-chain that a contract reads
with one `deserialize<T, N>` call, and decode bytes a contract produced with
`serialize<T, N>`. Zero runtime dependencies.

Every claim is pinned byte-for-byte against COMPILED circuits: the fixture
contract in [`tests/fixtures/serde-fixtures.compact`](tests/fixtures/serde-fixtures.compact)
wraps the builtins over structs exercising all supported types and combos, and
the tests assert twin/circuit equality in both directions.

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

Layout: fields in declaration order, little-endian, natural widths. `Boolean`
1 byte, `Uint<w>` ceil(w / 8) bytes (w at most 248), `Field` 32 bytes (below
the Fr modulus), `Bytes<n>` raw, `Vector<n, T>` n elements with no length
prefix, structs flatten. Values use the generated-binding shapes: bigint for
numbers, Uint8Array for bytes, plain objects for structs.

One divergence knob: circuits ignore garbage in the padding region, the twin
rejects it by default. Pass `{ ignorePadding: true }` to `compactDeserialize`
to mirror the circuit exactly.

Known compactc 0.33 limits (pinned by the tests): `serialize<T, N>` crashes
the COMPILER on vectors of structs, vectors of vectors, and struct nesting
deeper than one level. `deserialize<T, N>` handles all of those, so contracts
can still READ such payloads from off-chain encoders.

## Develop

```bash
yarn compile   # compile the fixture contract (needed before test/build)
yarn test      # pin the twin against the compiled circuits
yarn build     # typecheck + emit ./dist for publishing
```
