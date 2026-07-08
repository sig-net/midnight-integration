# Events (MIP-0002) on compactc 0.33 / midnight-js 5.0.0-beta.3

Back to [`index.md`](index.md) · related: [`cross-contract-calls.md`](cross-contract-calls.md), [`gotchas.md`](gotchas.md)

## The model in one screen

- Events are emitted from a circuit with the statement: `emit (EventType { ...fields });`
- **You cannot declare your own event type.** The `event` keyword is *reserved for future
  use* in compactc 0.33 — see [gotcha #1](gotchas.md#1). Event *types* come only from
  `CompactStandardLibrary`.
- There are **11 canonical event types** (the `ContractEventType` union), all from the stdlib:
  `ShieldedSpend`, `ShieldedReceive`, `ShieldedMint`, `ShieldedBurn`, `UnshieldedSpend`,
  `UnshieldedReceive`, `UnshieldedMint`, `UnshieldedBurn`, `Paused`, `Unpaused`, **`Misc`**.
  (Source: `node_modules/@midnight-ntwrk/midnight-js-types/dist/index.d.ts`, `type ContractEventType`.)
- **`Misc` is the general-purpose app event.** Shape: `Misc { name: Bytes<32>, payload: Bytes<256> }`.
- A **"custom event" = `Misc` + a serialized struct**: `name` is a tag identifying your event,
  `payload` is `serialize<YourStruct, 256>(...)`. Consumers filter by `name`, then
  `deserialize` the payload.

## Emit syntax (verified compiling)

Minimal, using the general-purpose `Misc`:

```compact
pragma language_version >= 0.25;
import CompactStandardLibrary;

export circuit ping(): [] {
  emit (Misc { name: pad(32, "ping"), payload: default<Bytes<256>> });
}
```

Custom structured event (the real pattern — from [`src/token.compact:42-58`](../src/token.compact)):

```compact
struct DepositEvent {
  amount: Uint<128>;    // 16 bytes
  sequence: Uint<64>;   //  8 bytes
}

export pure circuit encodeDepositEvent(amount: Uint<128>, sequence: Uint<64>): Bytes<256> {
  return serialize<DepositEvent, 256>(DepositEvent { amount: amount, sequence: sequence });
}

export circuit deposit(amount: Uint<128>): [] {
  const sequence = depositCount as Uint<64>;   // read counter BEFORE increment → 0-based
  depositCount.increment(1);
  lastAmount = disclose(amount);
  emit (Misc {
    name: pad(32, "deposit"),                              // Bytes<32> ascii tag, zero-padded
    payload: encodeDepositEvent(disclose(amount), disclose(sequence))
  });
}
```

Key building blocks:
- `pad(N, "text")` → zero-padded `Bytes<N>` from a string literal. Use for the `name` tag.
- `serialize<T, N>(value)` → `Bytes<N>`. Packs a struct into fixed-width bytes.
- `disclose(x)` — **required** when the value being emitted (or written to ledger) is derived
  from a witness or circuit parameter; emitting is a public disclosure. Omitting it is a
  compile error ("potential witness-value disclosure must be declared"). See [gotcha #9](gotchas.md#9).

The canonical stdlib example (all 11 event types) lives at
<https://github.com/midnightntwrk/midnight-js/blob/main/testkit-js/testkit-js-e2e/src/contract/events.compact>
and in this repo's OLD checkout at
`~/Projects/github.com/sig-net/midnight-erc20-vault/boilerplate/contract/src/signet-signer.compact`
(`emitPart` → `emit(Misc { name, payload: serialize<EventPart, 256>(...) })`, the exact
production pattern this KB's token contract mirrors).

## `serialize<T, N>` byte layout (verified empirically)

For `struct DepositEvent { amount: Uint<128>; sequence: Uint<64>; }`,
`serialize<DepositEvent, 256>({ amount: 4242, sequence: 7 })` produces (first 32 bytes):

```
9210000000000000000000000000000007000000000000000000000000000000
└──────── amount (bytes 0..16, LE) ────────┘└─ sequence (16..24, LE) ─┘  (rest zero-padded right)
```

Rules inferred:
- Fields are laid out **in declaration order**, **low bytes first (little-endian)** per field,
  each field occupying its natural width (`Uint<128>`→16B, `Uint<64>`→8B).
- The struct is packed at the **start** of the `Bytes<N>`, zero-padded on the **right** to `N`.
- Decode in TS: `0x9210` little-endian = `0x1092` = 4242. ✅

Decoding helper (TS), as used in the integration test:
```ts
const leBigint = (b: Uint8Array): bigint => { let r = 0n; for (let i = b.length-1; i>=0; i--) r = (r<<8n)|BigInt(b[i]); return r; };
const amount   = leBigint(payloadBytes.slice(0, 16));
const sequence = leBigint(payloadBytes.slice(16, 24));
```

## How `emit` lowers (for debugging the generated `managed/` code)

`emit (Misc {...})` compiles to a public-transcript `log` op. In the generated
`managed/<c>/contract/index.js` you'll see:

```js
__compactRuntime.queryLedgerState(context, partialProofData, [
  { push: { storage: false, value: StateValue.newArray()
      .arrayPush(newCell({ value: _descriptor_X.toValue(1n), ... }))    // version/tag frame
      .arrayPush(newCell({ value: _descriptor_Y.toValue(10n), ... }))   // event type id (Misc = 10)
      .arrayPush(newCell({ value: _descriptor_Z.toValue(<payload>), ... }))
      .encode() } },
  'log',                                                                // ← the event op
]);
```

Event-type ids seen in generated code: `Misc = 10`, `Paused = 8`, `Unpaused = 9` (others
1..7 for the shielded/unshielded variants). Presence of `'log'` in `index.js` is a
compile-time proof the emit was accepted (asserted in
[`tests/xcontract-events.test.ts`](../tests/xcontract-events.test.ts)).

## Reading events back (off the indexer)

Two verified paths on `PublicDataProvider` (from `@midnight-ntwrk/midnight-js-indexer-public-data-provider`):

| Method | Use |
|---|---|
| `queryContractEvents(filter, page?)` → `Promise<ContractEvent[]>` | point-in-time query (what the integration test uses). |
| `contractEventsObservable(filter, { startAt? })` → `Rx.Observable<ContractEvent>` | live subscription/streaming. |
| `getAllContractEvents(provider, filter)` → `AsyncIterable<ContractEvent>` | paginated exhaustive read (avoids manual offset traps). |

**Filter** (`ContractEventQueryFilter`):
```ts
{
  contractAddress: string,          // REQUIRED
  types?: ContractEventType[],      // omit = all; EMPTY ARRAY IS REJECTED (matches nothing)
  fieldPrefixes?: {...}[],          // only for standard (non-Misc) variants
  transactionHash?: string,         // narrow by CHAIN tx hash
  fromBlock?: number, toBlock?: number,  // inclusive block-height bounds
}
```

**`ContractEvent`** is a discriminated union on `eventType`. The `Misc` variant:
```ts
{ eventType: 'Misc'; name: string; payload: string;   // name & payload are HEX-encoded strings
  // + ContractEventBase:
  id: number;            // monotonic indexer cursor (resume after with fromId: id+1)
  maxId: number;         // chain tip for events
  version: number;       // payload schema version (iteration-1 = 1)
  contractAddress: string;
  transactionId: number; // ⚠ indexer BIGSERIAL row id, NOT the chain tx hash — see gotcha #13
  raw: string;           // opaque VersionedLogItem hex, carried verbatim
}
```

Working read + decode (from [`tests/integrationTest.test.ts`](../tests/integrationTest.test.ts), the event step):

```ts
const events = await pdp.queryContractEvents({ contractAddress: tokenAddress, types: ["Misc"] });
const match = events.find((e) => e.eventType === "Misc" && asciiTag(e.name) === "deposit");

const payload  = hexToBytes(match.payload);         // Buffer.from(stripHex(hex), "hex")
const amount   = leBigint(payload.slice(0, 16));    // → 4242n
const sequence = leBigint(payload.slice(16, 24));   // → 0n
// match.contractAddress === tokenAddress (compare stripHex + lowercase)

// helpers:
const stripHex  = (h) => (h.startsWith("0x") ? h.slice(2) : h);
const hexToBytes = (h) => Uint8Array.from(Buffer.from(stripHex(h), "hex"));
const asciiTag  = (h) => Buffer.from(hexToBytes(h)).toString("latin1").replace(/\0+$/, "");  // strip zero-pad
```

Notes:
- `name` / `payload` come back **hex-encoded** — always `Buffer.from(hex, "hex")` before use.
- **Event indexing lags block finalization.** Even after `callTx` resolves (tx finalized),
  poll `queryContractEvents` for a few seconds until your event appears. The integration test
  polls up to 60s at 1s intervals.
- The indexer image **must** be one that decodes MIP-0002 `Misc` events. This repo's
  `docker-compose.yaml` pins a `...contract-events...` indexer build specifically for this
  (see its comment referencing midnight-indexer#1279). A stock ledger-8-era indexer will not
  surface `Misc` events.

## Simulator reach limit (why offline tests assert less)

In a pure in-process run (`@midnight-ntwrk/compact-runtime`, no node/indexer), the emitted
event goes into the circuit's public transcript, which sits behind an **opaque WASM handle**
(`currentQueryContext` is just `{ __wbg_ptr }`). You **cannot read the event back
in-process**. So offline tests assert only: (a) the payload round-trips via the pure
`encode*` circuit, (b) the circuit runs and mutates ledger, (c) `'log'` appears in generated
code. Actual event **delivery** is only observable on a live node via the indexer — that's
what the integration test covers. See [gotcha #5](gotchas.md#5).
