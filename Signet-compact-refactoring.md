# Signet.compact — refactoring notes

A summary of the inline `TODO`/type notes scattered through
[`packages/signet-midnight/src/Signet.compact`](packages/signet-midnight/src/Signet.compact),
grouped by theme. These are design intentions captured next to the code; nothing
here has been actioned yet.

---

## 1. Generic transaction params (the big architectural direction)

The current request hard-codes an EVM-specific shape. Several notes point toward
making the request generic over its transaction-param type so other chains/tx
kinds can reuse the same machinery.

- **`EVMTransactionParams` → generic `TxParams`** — "consider generic typing to
  allow different EVM Transaction params to be provided" (line 56).
- **Fold calldata into the tx params** — "move `EVMCalldata` (generic call data)
  into `EVMTransactionParams` (which is generic 'transaction params')" (line 136).
- **Flatten MPC routing** into the request rather than nesting it (line 138).
- **`SignBidirectionalEvent<TxParams>` sketch** (lines 142–148) — an
  incomplete/pseudo-code struct proposing the target shape, mirroring the MPC's
  canonical `SignBidirectionalEvent`:
  - `sender` — address of the contract; the contract populates it.
  - `requestNonce: Uint<64>` — contract-local nonce at creation.
  - `txParams: TxParams` — the generic param payload.
  - `txParamType` — an enum discriminating which param type is carried.
  - "all the routing params" — routing folded in (per the flatten note above).

  This struct is not yet valid Compact — it's a design placeholder for the
  generic event.

---

## 2. `EVMTransactionParams` completeness

- **Full EIP-1559 / type-2 support** — "add all necessary parameters to support
  full Ethereum type 2 transactions (ensure any type 2 txn possible — except
  contract creation)" (line 55). Current struct omits fields (e.g. access list)
  needed for arbitrary type-2 transactions.

---

## 3. `EVMCalldata` flexibility & encoding

- **Serialize `funcSig`** to shrink `EVMCallDataSize` — "use serialised version
  of the funcSig to reduce EVMCallDataSize" (line 73).
- **Make `funcSig` optional**, and allow supplying the entire calldata blob
  directly — "ensure funcSig is optional and call data (all of it the entire
  EVMCalldata)" (line 74).
- **`argCount` word-count** — flagged "Word count!!" (line 77); revisit how used
  slots are counted/encoded.
- **More flexible argument formatting** for dynamic types like arrays (lines
  84–86). Sketched encoding:
  - `func(a: Address, b: []uint)` → `[address, 1, len, …]`
  - `func(0x1234324, [1,2,3])` → `[address, 3, 1, 2, 3]`
  - Action: look up the canonical ABI formatting to model this.

---

## 4. Field-size optimisation (`SignetMPCRoutingParams`) — reduce proving time

Overall: "optimise field sizes" (line 91). Several fields are oversized and
inflate proving cost:

- **`caip2Id: Bytes<32>`** — "confirm sufficient size for CAIP-2 standard"
  (line 93).
- **`keyVersion: Uint<32>`** — "can be much smaller" (line 96).
- **`path: Bytes<256>`** — "consider possible optimisation; keep unchanged for
  now" (line 99). Deferred.
- **`algo` / `dest` / `params`** — "possibly ENUMs; these fields are not used so
  we could make them small now" (line 105).
- **`outputDeserializationSchema` / `respondSerializationSchema`
  (`Bytes<128>` each)** — "dynamically size these 2 schemas to reduce proving
  type[time]" (line 111). Related note: look at the most popular DeFi contracts
  for schematisation of the schema types (line 110).

---

## 5. Naming verification

- **`SignetEVMSignatureResponse`** — "check solana repo for this name" (line 157)
  to confirm it matches the canonical vocabulary used elsewhere.

---

## Cross-cutting theme

Most notes serve two goals: (1) **generalisation** — moving from EVM-specific
structs to a generic, `txParamType`-discriminated request that mirrors the MPC's
`SignBidirectionalEvent` (items 1–3); and (2) **proof-cost reduction** — right-sizing
or dynamically sizing oversized `Bytes<N>`/`Uint<N>` fields, and possibly turning
unused opaque strings into enums (item 4).


```
ok, but that wouldn't solve it as there is not dynamic sizes AT ALL in compact. So the UI couldn't send an arbitrary byte length. The compiled contract would have to specify like a "max length" type #n and then the UI could only submit up to that length with some kind of padding. Unless data is stored outside of these structs in a List or something with pop and push functionality then only a pointer to that data is stored in here. But that breaks the SDK and gets out of control, the MPC will struggle. Stuff is all over the place.

Lets just focus on the dynamic args for now.

What I think we should do is come up with an K x m x n type solution where K is a fixed size, m and n are 'variable'. Then the contract can limit those to some maximums to throttle.

imagining something like:

export struct EVMType2TxParams<#maxWords> {
  // ...other fields...
  calldata: Maybe<EVMCallData<maxWords>>; 
  // ...other fields...
}

export struct EVMCallData<#maxWords> {
  functionSig: Bytes<4>; // The 4-byte selector (e.g., 0xa9059cbb)
  words: Vector<maxWords, ABIWord>; 
}

// Replaces your DynBox
export struct ABIWord {
  wordType: ABIWordType; // Enum to tell the MPC how to handle this chunk
  value: Bytes<32>;      // Every ABI slot is exactly 32 bytes
}

// Enum defining the word's purpose
export enum ABIWordType {
  StaticArg,    // Flat 32-byte values (address, uint256, bool)
  DynArgHead,   // 32-byte offset pointer
  DynArgLength, // 32-byte array/bytes length
  DynArgData,   // 32-byte chunk of the actual dynamic data
  Unused        // Crucial for filling up the Vector to #maxWords
}
```