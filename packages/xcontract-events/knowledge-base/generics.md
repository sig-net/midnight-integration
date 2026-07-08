# Generics in Compact (compactc 0.33) — and the monomorphic export boundary

Back to [`index.md`](index.md) · related: [`events.md`](events.md), [`cross-contract-calls.md`](cross-contract-calls.md), [`gotchas.md`](gotchas.md)

> **One-line rule:** generics work *inside* a contract, but **no exported circuit may be
> type-parameterized** — the compiled boundary must be monomorphic. All findings below are
> from compiling against compactc 0.33 (scratch experiments, not docs).

## The headline: you cannot export a generic circuit

This — the obvious way to make a deposit event carry arbitrary caller params — **does not compile**:

```compact
struct DepositEvent<T> { amount: Uint<128>; sequence: Uint<64>; depositCallerParams: T; }

export circuit deposit<T>(amount: Uint<128>, params: T): [] { ... }
//     ^^^^^^^^^^^^^^^^^^^^^ error:
// cannot export type-parameterized function (deposit) from the top level
```

An exported (top-level, on-chain-callable) circuit must have a fully concrete signature. This
is *why* client-specific typing in this repo is handled with runtime descriptors / TS twins
rather than per-client monomorphized circuits (see the `signet-midnight` design).

## What DOES compile (all verified)

| Pattern | Verdict |
|---|---|
| Generic struct: `struct DepositEvent<T> { ...; extra: T; }` | ✅ |
| Non-exported generic circuit: `circuit encode<T>(p: T): ...`, called `encode<Bytes<32>>(x)` | ✅ |
| `serialize<DepositEvent<Bytes<32>>, 256>(...)` (serialize a concretely-specialized generic) | ✅ |
| Exported circuit whose param/return is a **concretely-specialized** generic: `export circuit deposit(ev: DepositEvent<Bytes<32>>): []` | ✅ |
| Generic **module** specialized on import: `module Enc<T> { ... } import Enc<Bytes<32>>;` | ✅ |
| Multiple concrete specializations of one generic in one contract (`Ev<Bytes<32>>` and `Ev<Uint<64>>`) | ✅ |
| **Exported** generic circuit `export circuit f<T>(...)` | ❌ "cannot export type-parameterized function … from the top level" |
| Serialize a generic specialized to an **unsized/opaque** type (`Opaque<"string">`) | ❌ "type Opaque\<\"string\"\> (opaque) is not serializable" |

Two hard constraints fall out:
1. **Monomorphic boundary.** Genericity must be resolved to concrete types before the export.
   Keep generic structs/circuits/modules internal; expose only monomorphized circuits.
2. **Serialized type params must be statically sized & serializable.** `serialize<T,N>` needs
   `T`'s fields to have fixed byte widths. `Opaque<...>` (and other unsized types) are
   rejected. "Arbitrary caller params" therefore can't be an open blob through `serialize` —
   it must be a concrete sized type (`Bytes<N>`, or a struct of sized fields).

## The generated TS monomorphizes the generic away

Compiling the module-specialized version, the exported `deposit`'s generated signature
(`managed/*/contract/index.d.ts`) is:

```ts
deposit(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint, params_0: Uint8Array)
  : Promise<__compactRuntime.CircuitResults<PS, []>>;
```

No `<T>` survives — `Bytes<32>` became `Uint8Array`. The SDK caller sees a plain concrete
type. The type parameter is purely a compile-time convenience inside the contract.

## How to actually carry "arbitrary caller params" in a deposit event

Since the exported `deposit` can't be generic, monomorphize at the boundary:

```compact
// Generic stays INTERNAL (struct + module), specialized to a concrete sized blob.
struct DepositEvent<T> { amount: Uint<128>; sequence: Uint<64>; depositCallerParams: T; }

// Exported circuit takes a CONCRETE sized type for the caller params.
export circuit deposit(amount: Uint<128>, params: Bytes<64>): [] {
  const ev = DepositEvent<Bytes<64>> { amount: amount, sequence: 0, depositCallerParams: disclose(params) };
  emit (Misc { name: pad(32, "deposit"), payload: disclose(serialize<DepositEvent<Bytes<64>>, 256>(ev)) });
}
```

Off-chain, the caller serializes its own richly-typed params into that fixed-size `Bytes<N>`
field (and deserializes on read). The on-chain contract treats them as opaque sized bytes; the
"generic" typing lives entirely in TS. This is the same principle as reading events back:
the chain carries bytes, the app owns the schema (see [`events.md`](events.md) § payload layout).

> Reproduce any of this with the scratch loop in [`toolchain.md`](toolchain.md) § "Probe the
> compiler" — each row above is a 6-line `.compact` file away.
