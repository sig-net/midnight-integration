# signet-midnight-serde

Rust twin of Compact's builtin `serialize<T, N>` / `deserialize<T, N>` byte
layout: produce bytes off-chain that a Midnight contract reads with one
`deserialize<T, N>` call, and decode bytes a contract produced with
`serialize<T, N>`. Zero runtime dependencies. The sibling
[`midnight-serde-ts`](../midnight-serde-ts) package is the TypeScript twin of
the same layout.

The layout: struct fields and tuple elements pack in declaration order, every
value little-endian at its natural width (bounded uints and enums as wide as
their largest legal value, so `Uint<0..1>` and single-variant enums are ZERO
bytes), no tags, prefixes or gaps, right zero-padded to `Bytes<N>`. The
`Uint<0..n>` upper bound is EXCLUSIVE.

```rust
use signet_midnight_serde::{Descriptor, Value, U256, serialize, deserialize, DeserializeOptions};

// Compact: struct Result { ok: Boolean; amount: Uint<128>; }
let result = Descriptor::Struct {
    fields: vec![
        ("ok".to_string(), Descriptor::Boolean),
        ("amount".to_string(), Descriptor::UintBits { bits: 128 }),
    ],
};
let value = Value::Struct(vec![
    ("ok".to_string(), Value::Bool(true)),
    ("amount".to_string(), Value::Uint(U256::from(4242u64))),
]);

// serialize<Result, 128> twin: packed value at the start, zero-padded to 128.
let bytes = serialize(&result, &value, Some(128)).unwrap();
let decoded = deserialize(&result, &bytes, DeserializeOptions::default()).unwrap();
assert_eq!(decoded, value);
```

Strict by default, exactly like the TypeScript twin: out-of-range Uint, enum
and Field encodings fail where the circuit fails, and the two deliberate
divergences from the circuit both have opt-outs (`ignore_padding` for the
padding region the circuit ignores, `lenient_booleans` for the bytes above
0x01 the circuit decodes as false). Rejections carry language-neutral
category slugs via `Error::category`, shared with the conformance corpus.

## Testing

`cargo test --locked` replays every record of the COMMITTED golden corpus in
[`../midnight-serde-conformance/corpus/serde-corpus.jsonl`](../midnight-serde-conformance/corpus/serde-corpus.jsonl),
which is generated from compiled Compact circuits, Midnight's `toBinaryRepr`
oracle and the TypeScript twin, and guarded against staleness on the TS side.
A green run therefore proves this crate agrees with the compiled circuits
byte for byte, without Node or compactc anywhere near `cargo test`. A native
seeded sweep adds fresh randomised roundtrip coverage on top.

From the repo root: `yarn test:midnight-serde-rs` / `yarn build:midnight-serde-rs`.

## Pinning

An isolated crate (not part of any Cargo workspace): `Cargo.lock` is
committed and CI runs `--locked`, and `rust-toolchain.toml` pins the
toolchain. Releases go to crates.io through the repo's publish workflow
(OIDC trusted publishing), which skips any version already published.
