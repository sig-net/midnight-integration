# Question for the Midnight team — signet MPC signature requests on Midnight

Hi everyone and a happy Friday!

We have made great progress on our Signet Midnight integration, but before we finalise our v1 design we would like to check some of our architectural decision points with you.

The Signet bidrectional signature flow this design implements is as follows:
- A Client invokes a method on some contract (caller contract) on Midnight which composes and submits a `SignBidrectionalRequest`
   - This request for a particular transaction for some foreign chain to be signed
   - The request can be identified by a unique requestId
- MPC network observes the bidrectional signature request for the transaction, compiles the transaction, signs it, and publishes a `SignatureResponse`
- The Client observes the signature response and uses it to submit the signed transaction on the destination chain
- MPC network observes the signed transaction execution & publishes the signed result/output back to Midnight as `RespondBidirectional`
- Client observes the `RespondBidirectional` and submits it back to the original caller contract completing the bidirectional flow

These are the requirments of the architecture:
- arbitrary contracts must be able to communicate to the MPC that a signing request has been submitted
- arbitrary contracts must be able store the signature requests such that the MPC can find them without a harcoded list of "allowed callers"
- the MPC needs to able to verify which contract submitted the signature request
- arbitrary transactions need to be supported (i.e. EVM, Solana etc.)
- dynamic transaction size needs to be supported (e.g. for dynamic arguments like arrays)

The design we are looking at rignt now accomplishes this as follows:
- 1. Signature Requests are stored in the caller contract's own ledger. This solves attribution of the request to a specific contract.
- 2. A caller contract emits a notification event via cross a cross-contract call to a Signet singleton contract. The event indicates by field position where the index lives. The Signet singleton contract is the onchain registry of signature responses, and signed remote execution responses.

We are happy with (2.) - using a cross contract call to emitt an event as an MPC notification mechanism.

We would like to zoom in a bit more on (1.) to confirm that it is a reasonable and future proof approach.

First an explanation of this choice:
- For exported compact circuits (exporting required for cross contract calls) types cannot be generically configured. This makes it impossible to use a cross contract call to submit Signature requests to the Signet singleton contract as we would be forced to limit transaction size
- Storing the signature requests in an event emitted by the calling contract becomes overly complex as the event sizes are limited to a hard 256-byte payload. Coming up with a signature request splitting protocol that each client contract needs to implement is impractical and fragile.

Simplified code snippets of this implementation are as follows:

```
// --- Key Signet Protocol Data Structures ---

// Bidirectional signature request:
struct SignBidirectionalRequest<TxParams> {
   txParams: TxParams;        // generic txParams
   txParmsType: TxParamType;  // enum as off-chain decode tag
   // ...other signet routing fields...
}

// For EVM Type 2 Transaction TxParams is configured as follows by the client:
// (a decomposed EIP-1559 transaction)
struct EVMType2TxParams<#maxCalldataWords, #maxAccessListEntries, #maxStorageKeysPerEntry> {
   accessList: Vector<maxAccessListEntries, EVMAccessListEntry<maxStorageKeysPerEntry>>;
   calldata: Maybe<EVMCalldata<maxCalldataWords>>
   // ... other EVM Type 2 Transaction fields ...
}

// SignBidirectionalEvent notifies the MPC that a SignBidirectionalRequest has
// been stored in the caller's ledger.
export struct SignBidirectionalEvent {
   // Address of the calling contract; the MPC reads its request index there.
   callerAddress: ContractAddress,

   // Ledger field position of the Map<RequestId, SignBidirectionalRequest> in
   // the caller contract.
   signBidirectionalRequestsIndexField: Uint<8>,

   // ... other event fields ...
}

// --- Example Caller Contract Integration Implementation ---

// ... other caller contract ledger declarations possibly located here BEFORE signet requests index ...

// Signet EVM Requests index configured to hold EVM Type 2 Transactions with 2 call data words
export ledger signetEVMSignatureRequestsIndex: Map<RequestId, SignBidirectionalRequest<EVMType2TxParams<2, 0, 0>>>;

// ... other caller contract ledger declarations possibly located here AFTER signet requests index ...

// Some Caller contract method that initiates the sign bi-directional flow:
export circuit SomeMethodDoingCrossChainThing(): [] {

   // 1. caller constructs bidrectional signature request and calculates the requestId
   const request = constructSignBidirectionalRequest<EVMType2TxParams<2, 0, 0>>(
      // ... other request construction args ...
   );
   const requestId = calculateRequestId<EVMType2TxParams<2, 0, 0>>(request);

   // 2. caller inserts the bidrectional signature request into the index
   signetEVMSignatureRequestsIndex.insert(requestId, disclose(request));

   // 3. caller notifies the MPC of the signature request via a cross contract call via the signet contract
  signetEventEmitter.emitSignBidirectionalEvent(SignBidirectionalEvent{
    kernel.self(),
    requestId as Bytes<32>,
    // CRITICAL: caller contract indicates field location of the index
    signBidirectionalRequestsIndexField: 0 as Uint<8>,
  });   
}
```

# ---- Key Question 1 ----
The key question we have for this design is whether the declaration order of the ledger field index *position* is a stable, supported addressing scheme?
For the MPC indexer to read a signature request after observing the notification we rely on the declaration-order field index to locate the position to read out of. The [language reference](https://docs.midnight.network/compact/reference/compact-reference#identifiers-bindings-and-scope)
says a ledger field's "location in the (replicated) public state of a contract never
changes", and [toolchain 0.31.0](https://docs.midnight.network/relnotes/compact/toolchain-0.31.0)
added the ledger layout (`name`/`index`/`storage`/`type`) to `contract-info.json`
"suitable for language agnostic tooling".

1. Is **declaration order → flat field index** a compiler *contract* (stable across future
   `compactc` versions), or an implementation detail that happens to hold today? I.e. if a
   contract is recompiled and redeployed with unchanged ledger declarations, are the indices
   guaranteed identical?
2. Past 16 fields the runtime nests the root array ([`StateValue` `Array(n)`, `n ≤ 16`](https://github.com/midnightntwrk/midnight-ledger/blob/ledger-8/spec/onchain-runtime.md);
   [`PublicLedgerSegments`](https://docs.midnight.network/api-reference/compact-runtime/type-aliases/PublicLedgerSegments)
   describes the nesting). Is the chunking scheme (one level deep, order-preserving flatten)
   specified anywhere we can rely on, or should we treat `contract-info.json`'s `index` as
   the only source of truth for the path to a field?
3. Bottom line: is "contract X's request map is at ledger field N" a value we can safely
   persist and act on long-term (our protocol has callers announce N in an event), or do you
   foresee layout changes (reordering, optimization, sparse layouts) that would break it?
4. encoding stability: Reading raw ledger state without compiled artifacts: how stable is the encoding?

# Secondary question: 
- Events: is our interpretation correct that events, limited at 256 bytes and non configurable cannot support our generic payload type? Do you agree with our conclusion: events as **notification only**, ledger state as the
   **authoritative request record**? Or is there an intended pattern for large structured
   event payloads that we've missed?
— Cross-contract calls: monomorphic boundary No generic circuit surface.** The
[reference](https://docs.midnight.network/compact/reference/compact-reference#top-level-exports)
says exporting a generic circuit is a static error, and we've confirmed
`export circuit f<T>(...)` is rejected by compactc 0.33. So a singleton
`requestSignature(request: SignBidirectionalRequest<T>)` is impossible; the only
monomorphic escape is worst-case fixed buffers (e.g. `Bytes<2048>` calldata) for **every**
caller, inflating every caller's circuit size and proving time. Is that reading correct,
and is there any roadmap (contract interface types, per-caller specialization of a callee,
dynamic sizing) that would change it?