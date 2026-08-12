# @sig-net/midnight-serde

TypeScript twin of Compact's builtin `serialize<T, N>` / `deserialize<T, N>`
pair (CompactStandardLibrary). Produce bytes off-chain that a contract reads
with one `deserialize<T, N>` call, and decode bytes a contract produced with
`serialize<T, N>`. Zero runtime dependencies.

The layout has no single written spec upstream: it was reconstructed by
inspection ([Compact serialization protocol
(inferred)](#compact-serialization-protocol-inferred)), and every behaviour
documented here is verified by executing compiled circuits and a committed
cross-implementation corpus ([Trust and
verification](#trust-and-verification)).

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

The precise typing rides on the compiler seeing the descriptor's literal
shape, which is exactly what `as const satisfies CompactType` preserves. A
descriptor that reaches the call typed as plain `CompactType` (an explicit
annotation, a function parameter, or a descriptor built at runtime from
parsed input) behaves identically at runtime, but the compiler no longer
knows which kind it holds, so inference degrades to the loose union: values
go in and come out as `CompactValue`, and narrowing them is the caller's job.

```ts
const widened: CompactType = RESULT; // literal shape forgotten
const loose = compactDeserialize(widened, bytes);
//    ^? CompactValue
```

## Types and layout

Fields and elements pack in declaration order, little-endian, at their
natural widths, with no gaps and no length prefixes. "Natural width" means
each atom occupies exactly the bytes its own type needs (the widths in the
table), independent of its value and of its neighbours: no machine-word
alignment, no rounding up to powers of two, no padding between fields. Every
serializable Compact type has a descriptor kind (`Opaque<...>` is the one
exclusion: compactc itself rejects it as "not a serializable type"):

| Compact type | Descriptor | Packed width | Value type |
| --- | --- | --- | --- |
| `Boolean` | `{ kind: 'boolean' }` | 1 byte (0x00/0x01) | `boolean` |
| `Uint<w>` (sized) | `{ kind: 'uint', bits: w }` | ceil(w / 8), w at most 248 [2] | `bigint` |
| `Uint<0..n>` (bounded) | `{ kind: 'uint', bound: n }` | byte length of n - 1 [1] [2] [4] | `bigint` |
| `Field` | `{ kind: 'field' }` | 32 bytes, value below the Fr modulus [3] | `bigint` |
| `Bytes<n>` | `{ kind: 'bytes', length: n }` | n, raw [4] | `Uint8Array` |
| enum | `{ kind: 'enum', variants: k }` | byte length of k - 1 [1] [4] | `number` (index) |
| `Vector<n, T>` | `{ kind: 'vector', length: n, element }` | n elements, unprefixed [4] | `T[]` |
| `[T1, ..., Tn]` (tuple) | `{ kind: 'tuple', elements }` | elements back to back [4] | TS tuple |
| struct | `{ kind: 'struct', fields }` | fields back to back [4] | plain object |

Notes:

1. The `Uint<0..n>` upper bound is EXCLUSIVE, per the language reference:
   the values are 0 to n - 1, so `Uint<0..1000>` holds 0..999 in 2 bytes and
   `Uint<8>` is the same type as `Uint<0..256>`. An enum is
   `Uint<0..variants>` under the hood, packing its variant index.
2. The 248-bit ceiling exists so that every `Uint` fits in ONE field
   element: circuit values live in the BLS12-381 scalar field (note 3), and
   31 bytes is the largest whole number of bytes whose full range stays
   below that modulus. The language reference states the maximum `Uint`
   value as 256^31 - 1, which is exactly 2^248 - 1. Hence `w` at most 248
   and bounds at most 2^248: the cap is byte-granular, not the modulus
   itself.
3. Fr is the scalar field of BLS12-381, the curve Midnight's proof system
   operates over. Its order (the `FIELD_MODULUS` constant this package
   exports, `0x73eda753...00000001`, between 2^254 and 2^255) is the
   exclusive upper bound on every `Field` value. A `Field` still packs to a
   full 32 little-endian bytes, so the encoding space is not fully used:
   a 32-byte string at or above the modulus is rejected by the circuit and
   by the twin alike.
4. The width rules make some legal types ZERO bytes wide: `Uint<0..1>`, a
   single-variant enum, `Bytes<0>`, `Vector<0, T>`, the empty tuple and the
   empty struct all occupy no space (circuit-pinned). The principle: width
   is a function of the TYPE alone, never of the value, and a type with
   only one possible value carries no information, so it gets no bytes.
   The same principle cuts the other way: a value that uses less than its
   type never shrinks. `Maybe<Uint<64>>` is always 9 bytes, `none`
   included (the value arm rides along zero-filled), and both arms of an
   `Either` occupy their full width whatever the tag says.

`serialize<T, N>` places the packed value at the start of `Bytes<N>` and
zero-pads on the right. N below the packed size is a compile error in Compact
and a thrown error here.

Stdlib generics are plain structs in this layout, described with ordinary
struct descriptors: `Maybe<T>` is `{ is_some: Boolean; value: T }` and
`Either<A, B>` is `{ is_left: Boolean; left: A; right: B }`. The stdlib
constructors (`some`, `none`, `left`, `right`) zero-fill the unused arm, and
zero is a legal encoding for every Compact type, so constructor-built values
always decode here, strict mode included (all circuit-pinned, straight from
the constructors).

## Divergences from the circuit

Two divergences, both strict-by-default on DECODE, both pinned by tests with
bytes the circuit actually receives, and both with an opt-out. Bytes a
circuit produced never trigger either one, since `serialize<T, N>` only ever
writes zero padding and 0x00/0x01 booleans:

- **Padding:** the circuit ignores bytes in the padding region entirely, the
  twin rejects non-zero padding. Pass `{ ignorePadding: true }` to mirror
  the circuit's padding behaviour.
- **Booleans:** the circuit decodes ANY byte other than 0x01 as `false`
  (0x02..0xff included), the twin rejects bytes above 1. Pass
  `{ lenientBooleans: true }` to mirror the circuit's boolean behaviour.

With both options set, `compactDeserialize` is circuit-exact on arbitrary
bytes (pinned by tests). Everything else mirrors the circuit exactly,
including rejections: out-of-range bounded Uint, sized Uint, enum and Field
encodings throw in-circuit and throw here (all pinned by the tests).

The ENCODE side is stricter than TypeScript alone would be, in line with the
strict descriptor validation: a struct value with a property the descriptor
does not declare is rejected (a typo'd key alongside the correct ones would
otherwise vanish silently), array and byte lengths must match the descriptor
exactly, and out-of-range numerics throw. Two resource guards round this
off: descriptor lengths must be safe integers and computed packed sizes must
stay below `Number.MAX_SAFE_INTEGER` (never a silently rounded size), and a
decode refuses to materialise more than 65536 zero-width vector elements
(`Vector<huge, Nothing>` decodes from no input at all, so a hostile
descriptor could otherwise hang the process on an empty buffer).

Known compactc 0.33 limits (pinned by the tests): `serialize<T, N>` crashes
the COMPILER on vectors of structs, vectors of vectors, and struct nesting
deeper than one level. `deserialize<T, N>` handles all of those, so contracts
can still READ such payloads from off-chain encoders. Tuples are unaffected:
`serialize<[Pair, Boolean], N>` compiles fine.

## Compact serialization protocol (inferred)

No single upstream document specifies this layout. What follows is the
protocol as reconstructed from the compiler, the ledger sources and the
runtime, with the references that back each part.

Compact's `serialize<T, N>` is a compile-time expansion, not a library call:
the compiler monomorphises every call site into circuit code that walks the
type in declaration order and packs each atom at its natural width,
little-endian, with no tags, prefixes or gaps, then zero-pads the result on
the right to `Bytes<N>`. The layout it emits is the binary form of Midnight's
field-aligned binary (FAB) representation, the same bytes the ledger writes
as `persistentHash` preimages and that `toBinaryRepr` reproduces in the TS
runtime.

The defining property is that there is NO framing. Nesting exists only in
the type: it contributes nothing to the wire. Only leaf atoms are encoded,
concatenated in declaration order, so

```text
{ a: { b: { c: valueC } }, d: valueD }   -->   FAB(valueC) ++ FAB(valueD)
```

with no struct headers, no field tags, no lengths, no offsets. Concretely
(bytes verified against this package):

```text
struct Innermost { c: Uint<16>; }
struct Inner     { b: Innermost; }
struct Outer     { a: Inner; d: Boolean; }

serialize<Outer, 8>({ a: { b: { c: 4242 } }, d: true })

  92 10   01   00 00 00 00 00
  ─────   ──   ──────────────
  c       d    zero padding
  0x1092  true (right-fill to Bytes<8>)
  LE Uint<16>
```

Three levels of struct nesting flatten to three bytes. The corollaries: two
different types can produce identical bytes, so the bytes alone are
ambiguous and decoding always requires the full descriptor, and the
container width N is agreed out of band (it lives in the type on both
sides), never carried in the data.

At the pinned commits below, the only implementations of this layout in
Midnight's own code are one generator (the compiler pass), one Rust preimage
writer over the same atoms (`transient-crypto/src/fab.rs` plus its in-circuit
mirror in `zkir*/src/ir_vm.rs`), one TS flattener (`toBinaryRepr`), and
hand-rolled decoders in the SDK and the indexer. None of them is a reusable
serializer producing `Bytes<N>` from a value, hence this independent
implementation. Beware the name collision: the ledger's top-level
`serialize/` crate is a different, tagged transport format (streams begin
with the ASCII string `midnight:<tag>:`), not this layout.

Repositories are pinned at `LFDT-Minokawa/compact @ 5d8c66c`,
`midnightntwrk/midnight-ledger @ e1edad2` (branch `ledger-8`),
`midnightntwrk/midnight-sdk @ 80e6707`, `midnightntwrk/midnight-indexer @
345fcc2`.

| Source | What is here that is relevant |
| --- | --- |
| [compact: `compiler/analysis-passes/expand-serialize.ss`](https://github.com/LFDT-Minokawa/compact/blob/5d8c66c/compiler/analysis-passes/expand-serialize.ss) | The generator, and the closest thing to ground truth for the serialize direction. A nanopass that expands every `serialize`/`deserialize` call site into circuit expressions: declaration-order field walk, `field->bytes` at natural widths, booleans as literal `0x00`/`0x01`, enums cast to bounded Uint, right zero-padding, and the "serialized size exceeds specified length" compile error. |
| [compact: PR #470](https://github.com/LFDT-Minokawa/compact/pull/470) | The origin. Commit `0b3be94` ("[Issue 377] Events, phase 1", merged 2026-06-26) introduced the expand-serialize pass inside `analysis-passes.ss` as the canonical event encoding (the standalone file split out later in #632). |
| [compact: `doc/release-notes/toolchain-0.33.0.md`](https://github.com/LFDT-Minokawa/compact/blob/5d8c66c/doc/release-notes/toolchain-0.33.0.md) | Prose semantics of the user-facing builtins (lines 119-127): works for all Compact types except `Opaque` and contract types, too-small `N` is a compile error, zero padding on serialize, extra trailing bytes ignored on deserialize, events use "the equivalent of `serialize<T, #n>`". |
| [compact: `compiler/midnight-inlines.ss#L16-L24`](https://github.com/LFDT-Minokawa/compact/blob/5d8c66c/compiler/midnight-inlines.ss#L16-L24) | Where the standard library actually declares the builtins: `serialize` and `deserialize` are registered as inline entries (`[T (nat n)] ([value T]) (Bytes n)`) that expand into the IR forms the expand-serialize pass consumes. No event-type restriction exists in code. |
| [compact: `doc/api/CompactStandardLibrary/exports.md#L981`](https://github.com/LFDT-Minokawa/compact/blob/5d8c66c/doc/api/CompactStandardLibrary/exports.md#L981) | The documented `circuit serialize<T, #n>` / `deserialize<T, #n>` signatures. Beware: the doc says "`serialize` can only be instantiated for an event type and its canonical serialized size" (L983-985), left over from PR #470 where serialisation existed only for events. The 0.33 compiler accepts any serializable type. |
| [compact: `runtime/src/compact-types.ts#L651`](https://github.com/LFDT-Minokawa/compact/blob/5d8c66c/runtime/src/compact-types.ts#L651) | `toBinaryRepr`, the undocumented TS runtime re-implementation and our second test oracle. Flattens a descriptor's `ocrt.Value` along its `Alignment` (bytes atoms zero-filled to declared width, field atoms to 32 bytes, compress atoms rejected). |
| [Compact language reference](https://docs.midnight.network/compact/reference/compact-reference) | The type system: exclusive `Uint<0..n>` bounds, the maximum Uint value 256^31 - 1, TS representations of each type, implementation limits. |
| [midnight-ledger: `spec/field-aligned-binary.md`](https://github.com/midnightntwrk/midnight-ledger/blob/e1edad2/spec/field-aligned-binary.md) | The normative FAB spec. It covers two encodings, and only one is ours: the self-describing flagged-int wire format is NOT the `serialize<T, N>` layout, the binary representation of atoms is. The high-level mapping section (lines 186-218) pins declaration-order struct encoding and explicitly assigns the Compact-type-to-FAB mapping to the compiler. |
| [midnight-ledger: `base-crypto/src/fab/`](https://github.com/midnightntwrk/midnight-ledger/tree/e1edad2/base-crypto/src/fab) | The core FAB data model (`transient-crypto/src/fab.rs` only extends it): `Value`, `ValueAtom`, `Alignment`, `AlignmentAtom`, `AlignedValue` in `encoding.rs`, normal form via trailing-zero strip, declaration-order tuple concat in `alignments.rs`, little-endian integer conversions in `conversions.rs`. |
| [midnight-ledger: `transient-crypto/src/fab.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/e1edad2/transient-crypto/src/fab.rs) | The byte layout as Rust: the `ValueExt` trait (L35), the `Value::binary_repr_unchecked` traversal with zero-fill padding (L273), and the per-atom byte rules in `ValueAtomExt::binary_repr_unchecked` (L513): `Bytes{n}` as raw LE bytes zero-filled to `n`, `Field` as 32 bytes, `Compress` as a 32-byte Poseidon commitment. |
| [midnight-ledger: `base-crypto/src/hash.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/e1edad2/base-crypto/src/hash.rs) and [`zkir-v3/src/ir_vm.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/e1edad2/zkir-v3/src/ir_vm.rs) | Proof the layout is load-bearing: `persistent_hash` is SHA-256 over exactly these bytes (`ValueReprAlignedValue(value).binary_repr` at `ir_vm.rs` L524), and `fab_decode_to_bytes` (L80-181) is the in-circuit mirror of the same atom rules. |
| [midnight-sdk: `compact-js/compact-js/src/effect/ContractLog.ts`](https://github.com/midnightntwrk/midnight-sdk/blob/80e6707/compact-js/compact-js/src/effect/ContractLog.ts) | Hand-rolled decode of the eleven built-in ledger events from this same layout, decode only: 65-byte `Either` as `[is_left:1][left:32][right:32]`, little-endian `Uint<128>`. |
| [midnight-indexer: `indexer-common/src/domain/ledger/ledger_state.rs`](https://github.com/midnightntwrk/midnight-indexer/blob/345fcc2/indexer-common/src/domain/ledger/ledger_state.rs) | Midnight's production Rust decoder of the same event payload bytes, the reference `ContractLog.ts` itself calls authoritative (`EITHER_SIZE = 1 + 2 * 32`, `make_contract_event_attributes`). |

## Trust and verification

Every claim in this README is pinned byte-for-byte against COMPILED
circuits. The fixture contract and the shared descriptor tables live in the
sibling conformance kit
([`../midnight-serde-conformance`](../midnight-serde-conformance)): its
circuits wrap the builtins over structs exercising all supported types and
combos, and the tests assert twin/circuit equality in both directions. A
second oracle backs the serialize direction: `toBinaryRepr` from
`@midnight-ntwrk/compact-runtime` (via the conformance kit, never a runtime
dependency) must agree with the twin on every shape, including the shapes
compactc cannot compile `serialize<T, N>` for, and the oracle adapter
computes its byte widths independently of the twin's width logic, so a width
bug cannot cancel out of the comparison. On every run the tests also replay
the conformance kit's COMMITTED golden corpus (seeded randomised sweep
included): the same corpus every other implementation of this layout is
pinned against.

A caveat on what "circuit-pinned" means: the pins execute the compiler's JS
emission of each circuit (via `@midnight-ntwrk/compact-runtime` under
vitest), not the Impact VM or a prover. That JS is generated by the same
expand-serialize compiler pass as the in-circuit code, and the ledger
sources define the identical atom layout ([Compact serialization protocol
(inferred)](#compact-serialization-protocol-inferred)), but no test in this
package runs a proof or a node.

## Develop

```bash
yarn compile   # at the REPO ROOT: compiles the conformance fixture contract
yarn test      # pin the twin against the compiled circuits + toBinaryRepr + corpus
yarn build     # typecheck + emit ./dist for publishing
```
