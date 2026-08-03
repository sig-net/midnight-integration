# @sig-net/midnight

The [Sig Network](https://sig.network) [Distributed MPC](https://github.com/sig-net/mpc) integration for the [Midnight blockchain](https://midnight.network) lets contracts on Midnight execute arbitrary transactions on foreign blockchains, and respond to the results of those transactions.

`@sig-net/midnight` is the client-agnostic protocol library for that integration. It carries everything a Midnight contract or off-chain client needs to speak the signet protocol (the MPC's [sign bidirectional flow](#sign-bidirectional-flow)). It does not bind to any particular contract.

> ## 🚧 Under Construction 🚧
>
> This Sig Network Midnight integration is still under construction.
> Use at your own risk and expect rapid iteration.

## Package Contents
This package has 2 components:

- **Compact module** for contract code on chain: `.compact` sources for Compact contracts to import the protocol structs and circuits directly:

  ```compact
  import "@sig-net/midnight/src/Signet";
  ```

- **TypeScript library** for clients off chain: readers that poll the signet contract and verify the MPC's responses, key derivation and attestation crypto, output serialisation, the published per-network addresses and contstant values, and typed twins of the on-chain structs and circuits.

The [Export highlights](#export-highlights) section lists the specific exports each task uses.

## Install

```sh
npm install @sig-net/midnight
```

## Sign bidirectional flow

The flow has 5 steps:

1. Client calls a contract on Midnight. The contract requests a signature for a transaction destined for a foreign chain. The signature is made with a key derived for the requesting contract (see [Derived keys](#derived-keys)).
2. The Sig Network MPC serves the request: it generates the transaction signature and posts it back to Midnight to the Sig Network Singleton Contract.
3. The client extracts the signature (from the Sig Network Singleton) and uses it to submit the signed transaction to the foreign chain.
4. The MPC observes the foreign transaction and posts an attestation of the execution back to Midnight to the Sig Network Singleton Contract. The attestation is an ECDSA signature over the digest `keccak256(requestId || serializedOutput)` created using the requesting contract's MPC response key (see [Derived keys](#derived-keys)). Both the digest and the output itself travel off chain.
5. The client obtains the execution output off chain (it broadcast the transaction in step 3, so it can read the result, see the output recovery note below for more details). It extracts the posted attestation and submits both back to the calling Midnight contract (same contract as step 1). The contract recomputes the digest from the output bytes and verifies the MPC's signature in-circuit against its own response key (see [Derived keys](#derived-keys)). The contract can then respond to the foreign execution output. This completes the foreign transaction execution.

> **Output recovery:** how the client reads the execution output is chain-specific. For EVM chains it is the mined call's return data. Extract it with `debug_traceTransaction` (callTracer, top call frame), the same RPC method the MPC observes executions with. Clients without trace access can fetch the raw output from the fakenet responder's helper API at `GET /responses/{requestId}` (served by [`ResponsesApi.ts`](https://github.com/sig-net/solana-signet-program/blob/fakenet-v0.8.0/fakenet-signer/src/server/ResponsesApi.ts), port 3040 in the local stack). The fetched bytes stay untrusted until step 5's in-circuit signature verification.

## Derived keys

Every key the MPC uses is derived for the requesting contract and a path. There are two kinds. The request signing key: derived from a path chosen by the requesting contract. The response signing key: derived from a path fixed by the protocol. Both key derivations are **scoped by the address** of the requesting contract ensuring that only a requesting contract has access to its own keys.

### Request signing key

The key the MPC uses to sign requested foreign transactions:

`requestSigningKey = f(mpcRootKey[keyVersion], caip2ChainId, contractAddress, hex::encode(path))`

The path is 32 opaque bytes of the contract's choosing (for example a fixed literal for a contract-owned account like "vault", or a hash of a caller's secret for per-user accounts). There are no format requirements: any 32 bytes are valid. **CRITICAL:** the MPC renders the path as `hex::encode(path)` before it derives the key: lowercase hex of the full 32 bytes, no trimming, no `0x` prefix. The contract address is always part of the derivation, so no contract can reach another contract's derived keys.

### Response key

The key the MPC uses to sign remote execution attestations when it posts them back to Midnight:

`responseKey = f(mpcRootKey[keyVersion], caip2ChainId, contractAddress, "midnight response key")`

This is the same derivation, but with the path fixed to the literal `"midnight response key"`. This fixed path is a protocol string that enters the derivation verbatim (no hex rendering, unlike a request's 32 path bytes). Each contract therefore has one well-known response key. A contract pins its own response key in its ledger after deploy, and verifies every response against it in-circuit (step 5 of the flow above).

> **keyVersion** is the version of the MPC root key that the derivation starts from. Current deployments use version `1`.
>
> **caip2ChainId** is the id of the chain the request originates from, in [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) form. For signature requests made on Midnight it is the Midnight variant (currently `midnight:testnet`). It is not the target chain id carried in the request record's `caip2Id` field.

## Integrator guide

A signet-compliant client contract does four things:

- it stores its requests in a public `SignBidirectionalEventMap` in its own ledger
- it pins its counterparties: the Signet singleton contract and its own MPC response key
- it submits signature requests
- it verifies execution responses in-circuit

The integration consists of:

- 3 once-off **setup** steps
- 5 per-request **runtime** steps that drive the full sign bidirectional flow

### Setup

Set up your contract for integration with the Sig Network MPC's sign bidirectional flow:

1. Import the Signet module at the top of your contract (resolved through `node_modules` via `COMPACT_PATH`):

   ```compact
   import "@sig-net/midnight/src/Signet";
   ```

   Then point the compact compiler at the npm packages with its `COMPACT_PATH` environment variable at compile time:

   ```sh
   COMPACT_PATH=node_modules compact compile --feature-zkir-v3 src/my-contract.compact src/managed/my-contract
   ```

   Compile with the pinned toolchain (currently `compact update 0.33.0-rc.2`), and always pass `--feature-zkir-v3`. Compiled output without that flag is not compatible with the ledger-9 matched stack (node, indexer, proof server).

2. Declare the required Sig Network protocol state in your ledger, plus the recommended deployer identity and initialisation state. The event map can sit at ANY ledger field: each notification your contract registers carries the map's resolved ledger-tree path (see [The request map's ledger-tree path](#the-request-maps-ledger-tree-path)), and the MPC reads the authenticated request from there.

   ```compact
   // Required: Map of SignBidirectionalEvent signature requests, configured by transaction type.
   // Configured and sized here for an EVM Type 2 transaction with
   // <1 calldata word, 0 access-list entries, 0 storage keys> and
   // 34-byte serialisation schemas.
   export ledger signBidirectionalEventMap: SignBidirectionalEventMap<EvmType2TxParams<1, 0, 0>, 34, 34>;

   // Required: The Signet singleton signer interface, set at deploy.
   // Used to notify the MPC of events you add to your signBidirectionalEventMap.
   sealed ledger signetSigner: SignetSigner;

   // Required: This contract's MPC response key, set in step 3.
   // Used to verify RespondBidirectionalEvents attesting the serialised output of foreign chain execution.
   export ledger mpcResponseKey: Secp256k1Point;

   // Recommended: contract-local source of request nonces, so identical
   // requests hash to distinct request ids. Nothing off-chain reads it.
   export ledger signetRequestNonce: Counter;

   // Recommended: used in step 3 to ensure initialisation runs only once.
   export ledger initialised: Counter;

   // Recommended: set on deploy, used in step 3 to ensure only the deployer may set the mpcResponseKey.
   sealed ledger deployer: Bytes<32>;

   // Recommended: supplies the deployer's identity secret from private state
   // off-chain. Only its commitment (below) ever reaches the ledger.
   witness witnessDeployerSecretKey(): Bytes<32>;

   // Recommended: the deployer identity commitment scheme. Exported so deploy
   // tooling can compute the constructor argument by calling the compiled circuit.
   export pure circuit calculateDeployerCommitment(sk: Bytes<32>): Bytes<32> {
     return persistentHash<Vector<2, Bytes<32>>>([pad(32, "my-contract:deployer:"), sk]);
   }

   // Required: set signet contract and (recommended) deployer commitment on deployment.
   constructor(signetContract: SignetSigner, deployerCommitment: Bytes<32>) {
     signetSigner = disclose(signetContract);
     deployer = disclose(deployerCommitment);
   }
   ```

3. Set the contract's MPC response key once, right after deploy. Deriving this key requires the address of the contract, which only exists after deploy (see [Response key](#response-key)):

   ```compact
   export circuit initialise(responseKey: Secp256k1Point): [] {
     // Recommended: confirm that only the deployer may initialise, and only once:
     assert(deployer == calculateDeployerCommitment(witnessDeployerSecretKey()), "Not the deployer");
     assert(initialised == 0, "Already initialised");
     initialised.increment(1);

     // Required: set MPC response key for verification of RespondBidirectionalEvents
     mpcResponseKey = disclose(responseKey);
   }
   ```

### The request map's ledger-tree path

Each notification must tell the MPC where your `signBidirectionalEventMap` sits in your contract's compiled on-chain state. The MPC uses this location to read the authenticated request out of raw contract state. The location is a path in the state tree, passed to `constructSignBidirectionalEventNotificationV1` as two arguments:

- `requestsPathDepth`: the number of meaningful entries in the path (1 to 4).
- `requestsPath`: the path itself, zero padded to 4 entries.

The path shape comes from how compactc lays out state. The compiler packs a contract's public ledger fields into a tree whose array nodes hold at most 15 entries. With 15 or fewer fields, field N sits directly in the root array, at path `[N]` (depth 1). With more than 15 fields, the compiler groups the fields into segments of at most 15 (the remainder segment first), and the root array holds the segments. Each grouping adds one level to the tree and one entry to every field's path. A 20-field contract splits 5 + 15: field 4 sits at `[0, 4]` and field 19 sits at `[1, 14]` (depth 2).

**Do not derive the path by hand**. The compiler records it in your compiled artefacts. Compile your contract, then look up your request map's `"path"` in its generated accessor in `managed/<contract>/contract/index.js`. Its accessor shows the indices that the Signet Protocol needs: for example `state.asArray()[1].asArray()[14]` for a map recorded at `[1, 14]`. That path packs as `requestsPathDepth = 2` and `requestsPath = [1, 14, 0, 0]`.

The two caller contracts in the [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration) repository are worked examples of each case:

- [`test-caller-contract`](https://github.com/sig-net/midnight-integration/tree/main/packages/test-caller-contract): the flat case. Its 8-field ledger stores the map at field 4, so notifications carry depth `1` and path `[4, 0, 0, 0]`.
- [`test-caller-contract-20-field`](https://github.com/sig-net/midnight-integration/tree/main/packages/test-caller-contract-20-field): the chunked case. Its 20 fields split 5 + 15, so the map at field 19 packs as depth `2` and path `[1, 14, 0, 0]`.

### Runtime

Each interaction with your contract that executes a transaction on a foreign chain runs these 5 steps.

Steps 1 and 5 are circuits on your contract. Steps 2 to 4 are off-chain client code built on the utilities in `@sig-net/midnight`.

The off-chain steps share two values. The first is one `SignetRequestResponseReader` over your contract and the Signet singleton. The second is the expected signer of the requested transaction: the key the MPC derives for your contract and the request's path (see [Derived keys](#derived-keys)).

```ts
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { deriveEvmAddress, SignetRequestResponseReader } from "@sig-net/midnight";

// SignetRequestResponseReader to poll for Signed Transactions and Signed RespondBidirectionalEvents
const reader = new SignetRequestResponseReader({
   // Address of YOUR deployed contract
   requesterContractAddress: myContractAddress,

   // signBidirectionalEventMap's ledger-tree path (see The request map's ledger-tree path)
   requesterRequestsPath: [0],
   // signBidirectionalEventMap's ledger-tree path (see The request map's ledger-tree path)
   requesterRequestsPath: [0],

   // Address of the Signet singleton contract
   signetContractAddress,

   // Provider to index Midnight Blockchain
   publicDataProvider: indexerPublicDataProvider({
      queryURL: indexerUrl,
      subscriptionURL: indexerWsUrl
   }),
});

const expectedSigner = deriveEvmAddress(mpcRootPublicKey, myContractAddress, "my-path");
```

> **mpcRootPublicKey** is the root public key of the MPC network. On a local stack there is no fixed value: the [integration-test setup](https://github.com/sig-net/midnight-integration/tree/main/packages/integration-tests) generates a fresh `MPC_ROOT_KEY`, prints it during setup and appends it to the repo-root `.env`. For the public networks (stagenet, preview, preprod, mainnet) the fixed values are published in this package via `getMpcRootPublicKey` (placeholders until each network's key is published).
>
> **signetContractAddress** is the address of the deployed Signet singleton contract. On a local stack the same setup deploys a fresh singleton, prints the address as `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` and appends it to `.env`. For the public networks the addresses are published in this package via `getSignetContractAddress` (placeholders until each deployment lands).

1. Store a signature request and notify the MPC via a cross contract call. Build (or overwrite) every part of the transaction your contract enforces in-circuit, calldata above all (see [EVM Type 2 transactions and ABI calldata words](#evm-type-2-transactions-and-abi-calldata-words)). Never pass caller input through unchecked:

   ```compact
   // Construct SignBidirectionalEvent signature request and calculate its RequestId
   const request = constructSignBidirectionalEvent<EvmType2TxParams<1, 0, 0>, 34, 34>(/* ... */);
   const requestId = disclose(calculateRequestId<EvmType2TxParams<1, 0, 0>, 34, 34>(request));

   // Store the signature request in your signBidirectionalEventMap for MPC to discover
   signetRequestNonce.increment(1);
   signBidirectionalEventMap.insert(requestId, disclose(request));

   // Notify the MPC of the SignBidirectionalEvent and the location of your signBidirectionalEventMap.
   // The map is at ledger field 0 (Setup step 2), so its path is [0] at depth 1
   // (see The request map's ledger-tree path).
   // The map is at ledger field 0 (Setup step 2), so its path is [0] at depth 1
   // (see The request map's ledger-tree path).
   signetSigner.signBidirectional(
      requestId,
      constructSignBidirectionalEventNotificationV1(
         kernel.self(),
         1 as Uint<8>,                        // requestsPathDepth
         [0, 0, 0, 0] as Vector<4, Uint<8>>,  // requestsPath, zero padded
      ),
   );
   ```

   **NOTE:** Return `requestId` from this circuit call so the client can use it in the next steps. You can also compute it off-chain with the `calculateRequestId` TS twin.

2. Poll the Signet singleton for the MPC's signature response. The response log is unauthenticated (anyone can post), so use the verifying getter. It only returns a post whose signature recovers to `expectedSigner` over the requested transaction's signing hash:

   ```ts
   const { verified } = await reader.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
   // verified === undefined: no valid response posted yet, poll again.
   ```

3. Construct the signed transaction and submit it to the foreign chain. The reader rebuilds the transaction from the request record on your ledger and attaches the verified MPC signature:

   ```ts
   import { JsonRpcProvider } from "ethers";

   const signedTx = await reader.getSignedEvmTransaction(requestId, expectedSigner);
   await new JsonRpcProvider(foreignChainRpcUrl).broadcastTransaction(signedTx.serialized);
   ```

4. Poll the Signet singleton for the MPC's attestation of the remote execution output. The MPC posts it once it observes the transaction execute on the foreign chain. The event carries the MPC's signature alone: both the attestation digest and the serialised output travel off chain (you broadcast the transaction in step 3, so you can read its result). The log is unauthenticated, so use the verifying getter, as in step 2. It recomputes the digest over the output you present, and only returns a post whose signature verifies against your contract's response key.

   ```ts
   const respondBidirectionalEvent = await reader.getVerifiedRespondBidirectionalEvent(
      requestId,
      serializedOutput,
      mpcResponseKey,
   );
   // undefined: no attestation of that output posted yet, poll again.
   ```

5. Deliver the response and the serialised output to your contract. The contract recomputes the attestation digest, verifies the event in-circuit against the response key pinned in Setup step 3, and consumes the request. The width argument is the exact packed size of your respond serialisation schema (a single bool packs to 1 byte):

   ```compact
   assert(
      verifyRespondBidirectionalEvent<1>(requestId, serializedOutput, respondBidirectionalEvent, mpcResponseKey),
      "Invalid attestation signature"
   );
   signBidirectionalEventMap.remove(requestId);
   ```

## EVM Type 2 transactions and ABI calldata words

An `EvmType2TxParams` request decomposes the EVM transaction into typed fields, so your contract can enforce each field in-circuit. Its optional `calldata` is an `EvmCalldata<maxWords>`: the 4-byte function selector plus a list of 32-byte ABI words, per the [Solidity ABI spec](https://docs.soliditylang.org/en/latest/abi-spec.html). Slots past `noWords` are unused capacity and never reach the transaction.

Every word must be stored in canonical ABI form (big-endian). The MPC signs a transaction whose calldata is exactly `selector || words[0..noWords]`, byte for byte. A word stored in any other form becomes a signed transaction that calls the foreign contract with garbage arguments. Compact's integer casts are little-endian, so do not hand-roll the byte order. Build every word with the module's helper circuits, and read words back with the matching readers.

| Solidity type | Build with | Read back with |
|---|---|---|
| `address` | `evmAddressAbiWord(addr: Bytes<20>)` | |
| unsigned integers up to `uint128` (amounts, ids) | `numericAbiWord(value: Uint<128>)` | `abiWordToUint128(word)` |
| `bool` | `boolAbiWord(value: Boolean)` | `abiWordToBool(word)` |

### Example: an ERC20 transfer

`transfer(address,uint256)`, selector `0xa9059cbb`, takes an address word and a numeric word:

```compact
const calldata = EvmCalldata<2> {
  selector: Bytes[0xa9, 0x05, 0x9c, 0xbb],
  noWords: 2 as Uint<16>,
  words: [
    evmAddressAbiWord(recipient),  // address argument (Bytes<20>)
    numericAbiWord(amount)         // uint256 argument (from a Uint<128>)
  ]
};
```

### Example: a bool argument, and decoding a bool result

`setApprovalForAll(address,bool)`, selector `0xa22cb465`:

```compact
const calldata = EvmCalldata<2> {
  selector: Bytes[0xa2, 0x2c, 0xb4, 0x65],
  noWords: 2 as Uint<16>,
  words: [
    evmAddressAbiWord(operator),
    boolAbiWord(true)
  ]
};
```

The readers run the same rules in the other direction. They reject any non-canonical word outright (no silent truncation or coercion).

The builders and readers apply to CALLDATA words only. The serialised output a settle circuit verifies (the explicit `serializedOutput` argument `verifyRespondBidirectionalEvent` recomputes the attestation digest from) is NOT ABI words. It is the packed respond payload produced from the request's respond serialisation schema (a bool packs to 1 byte). The circuit reads it with a single stdlib `deserialize<T, N>` call, where `T` is a struct that mirrors the schema and `N` is the schema's packed size. For an ERC20 `transfer`'s `bool` return under a one-field bool schema:

```compact
struct TransferResult {
  success: Boolean;
}

const result = deserialize<TransferResult, 1>(serializedOutput);
assert(result.success, "Remote transfer failed");
```

**Respond schema range trap:** the respond serialisation maps `uint256`, `address` and `field` to Compact `Field`. `Field` values must lie strictly below the BLS12-381 Fr modulus (just under 2^255). An EVM `uint256` at or above Fr cannot be respond-serialised, and `serializeRespondOutput` throws at respond time (a max-uint256 allowance readback is the everyday case). When the full 256-bit range matters, declare the field as `bytes32` in the respond schema instead.

The same builders and readers exist as TypeScript twins under identical names, for composing expected words off-chain (UIs, expected-record builders, tests). This package's test suite keeps them in lockstep with the compiled circuits.

## Export highlights

The exports you reach for when integrating, by task.

### Compact module

What your contract imports with `import "@sig-net/midnight/src/Signet"`:

| Task | Exports |
|---|---|
| Declare the protocol ledger state (setup step 2) | `SignBidirectionalEventMap` (the request map the MPC reads) and `SignetSigner` (the Signet singleton's cross-contract-call interface, pinned at deploy). |
| Build and store a signature request (runtime step 1) | `constructSignBidirectionalEvent` and `calculateRequestId`, over the request structs `EvmType2TxParams`, `EvmCalldata` and `EvmAccessListEntry`. |
| Notify the MPC of the request (runtime step 1) | `constructSignBidirectionalEventNotificationV1`: packs your contract's address and the request map's ledger-tree path. |
| Build and read calldata words in-circuit | The builders `evmAddressAbiWord`, `numericAbiWord` and `boolAbiWord`, and the readers `abiWordToUint128` and `abiWordToBool` (see [EVM Type 2 transactions and ABI calldata words](#evm-type-2-transactions-and-abi-calldata-words)). |
| Verify the execution attestation (runtime step 5) | `verifyRespondBidirectionalEvent`: recomputes the attestation digest from the output bytes and checks the MPC's signature against your pinned response key. |

### TypeScript library

What clients import from `@sig-net/midnight`:

| Task | Exports |
|---|---|
| Poll for the MPC's responses and verify them (runtime steps 2 to 4) | `SignetRequestResponseReader`: one reader per contract and Signet singleton pair. Its getters `getVerifiedSignatureRespondedEvent`, `getSignedEvmTransaction` and `getVerifiedRespondBidirectionalEvent` map to steps 2, 3 and 4. |
| Derive the key the MPC signs your requests with | `deriveEvmAddress`: the expected signer address checked in step 2 (see [Derived keys](#derived-keys)). |
| Derive the response key your deploy pins | `deriveMidnightResponseKey`: the key `initialise` stores (setup step 3), derived from your contract's address. |
| Look up published counterparty values | `MidnightNetwork`, `getMpcRootPublicKey` and `getSignetContractAddress`: the fixed per-network values (see the notes in [Runtime](#runtime)). |
| Compute a request id off chain | `calculateRequestId`: the TS twin of the on-chain circuit, plus `requestIdHex` and `parseRequestIdHex` for the hex form. |
| Compose expected calldata words off chain (UIs, expected-record builders, tests) | The builders `numericAbiWord`, `evmAddressAbiWord` and `boolAbiWord`, and the readers `abiWordToUint128` and `abiWordToBool`: TS twins of the circuits under identical names (see [EVM Type 2 transactions and ABI calldata words](#evm-type-2-transactions-and-abi-calldata-words)). |
| Convert a foreign execution output into respond bytes | `deserializeEvmOutput` (raw EVM return data to named values) and `serializeRespondOutput` (named values to the packed respond payload the MPC attests): together they rebuild the `serializedOutput` of steps 4 and 5. |
| Recognise a failed remote execution | `MPC_FAILURE_OUTPUT` and `isMpcFailureOutput`: the MPC's fixed 5-byte failure payload for reverted or replaced transactions. |
| Verify attestations without the reader | `calculateSignetAttestationDigest` and `verifyRespondBidirectionalSignature`: the checks the reader runs internally, exposed for custom pipelines. |
| Discover and authenticate requests MPC-side (responders, background workers) | `SignetRequestFeed` (polls the signet contract's notification registry, dedupes by request id) and `SignetRequestResolver` (authenticates each notification against the caller contract's ledger). |
| Call the compiled protocol circuits | `pureCircuits`: the compiled circuits of `Signet.compact`, for example the notification packer. Off-chain code calls these compiled artefacts, so it always agrees with what the contracts prove. |

## More examples

For full integration examples (such as an ERC20 cross chain vault) see the [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples) repository.

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the central signet contract this library reads from.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploy tooling for that contract plus generic Midnight deploy/wallet plumbing.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration).
