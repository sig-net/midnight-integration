# Sig Network Midnight Integration

The [Sig Network](https://sig.network) [Distributed MPC](https://github.com/sig-net/mpc) integration for the [Midnight Blockchain](https://midnight.network) allows contracts on Midnight to execute arbitrary transactions on foreign blockchains.

> ## 🚧 Under Construction 🚧
>
> This Integration is still Under Construction.
> Use at your own risk and expect rapid iteration.

It achieves this by exposing the MPC's [sign bidirectional flow](#sign-bidirectional-protocol-flow) to contracts on Midnight.

This repository contains the pieces that make that flow available on Midnight:
- [Client-agnostic Compact and TS SDK](./packages/signet-midnight/README.md)
  - For Midnight Contract and dApp builders to integrate with Sig Network
  - Located in `packages/signet-midnight`
- [Sig Network Protocol Singleton Contract](./packages/signet-contract/README.md)
  - The protocol contract that integrating Midnight contracts communicate with via cross contract call
  - Located in `packages/signet-contract`
- Two test caller contracts that exercise the protocol end to end
  - Located in `packages/test-caller-contract` & `packages/test-caller-contract-20-field`

Example applications built on this integration (such as an ERC20 cross chain vault demo) live in a separate repository [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Read more about the [Sign Bidirectional Protocol Flow](#sign-bidirectional-protocol-flow), or jump straight to the [Integrator Guide](#integrator-guide) or the [Contributor Guide](#contributor-guide) depending on your goal. The [Prerequisites](#prerequisites) are relevant to both.

# Sign Bidirectional Protocol Flow

This Sig Network Protocol Flow brings foreign blockchain assets and functionality to contracts on Midnight. Contracts record signature requests that the Sig Network MPC signs. dApps relay signed transactions to foreign chains and the MPC attests their execution outcomes back to Midnight. Then contracts complete cross chain interactions with in-circuit validation of the MPC foreign execution attestation.

Illustrated below, the protocol is best understood in 5 steps:

<img src="./docs/sign-bidirectional-flow.drawio.png">

- **1.** A user interacts with a dApp, which starts a cross chain interaction by calling a circuit (`startCrossChain(...)` in the diagram) on a contract on Midnight that has integrated with Sig Network.
   - The integrating contract constructs a **[SignBidirectionalEvent](./packages/signet-midnight/src/Signet.compact#L69)** (aka. signature request) which it stores in its ledger's **[SignBidirectionalEventMap](./packages/signet-midnight/src/Signet.compact#L197)** against the associated **[RequestId](./packages/signet-midnight/src/Signet.compact#L171)** (hash of the SignBidirectionalEvent). The **SignBidirectionalEvent** contains the fields of a transaction destined for a foreign blockchain, as well as a path property which the Sig Network Distributed MPC uses to derive a **Request Signing Key** to sign the transaction (see [Derived Keys](#derived-keys) for more on this key).
   - Then the integrating contract performs a cross contract call to the [`signBidirectional`](./packages/signet-contract/src/signet-contract.compact#L31) circuit on the [**Sig Network Singleton** contract](./packages/signet-contract/src/signet-contract.compact) which emits a [**SignBidirectionalEventNotification**](./packages/signet-midnight/src/Signet.compact#L218). The **SignBidirectionalEventNotification** carries the address of the integrating client contract and the ledger location of its request map, and the **RequestId** travels beside it as `signBidirectional`'s first argument, so the emitted event gives the MPC everything it needs to find the stored **SignBidirectionalEvent** signature request.
- **2.** The MPC network, watching for events on the Singleton contract, picks up the emitted **SignBidirectionalEventNotification** and honours the signature request it points to.
  - The MPC verifies the notification before honouring it (see [Sign Bidirectional Event Discovery & Verification](#sign-bidirectional-event-discovery--verification)).
  - The MPC uses the information in the event to find and read the addressed **SignBidirectionalEvent** signature request that the identified Integrating Client Contract stored in its state in step **1.**.
  - It honours the request by constructing the contained foreign blockchain transaction and signing it with the associated **Request Signing Key**, derived for that contract and the path of the signature request.
  - The signature is then made available on Midnight with the MPC calling the [`respond`](./packages/signet-contract/src/signet-contract.compact#L52) circuit on the **Sig Network Singleton**, emitting a **[SignatureRespondedEvent](./packages/signet-midnight/src/Signet.compact#L282)**.
- **3.** The integrating dApp, watching for events on the Singleton contract, picks up the emitted **SignatureRespondedEvent** and relays the fully signed transaction to the foreign chain.
  - The dApp verifies the posted MPC signature is by the requested signer (i.e. the **Request Signing Key**) and uses it to construct the fully signed foreign blockchain transaction.
  - Acting as the relayer, the dApp then submits the signed transaction to the foreign chain for execution.
  - **Note:** The MPC only ever signs. Broadcasting is the dApp's responsibility.
- **4.** The MPC network observes execution of the signed transaction on the foreign blockchain and posts an attestation thereof back to Midnight.
  - The MPC network, watching for transaction executions on the foreign blockchain, observes execution of the transaction signed in step **2.**.
  - The serialised output it attests depends on whether that execution succeeded:
    - **Foreign transaction success:** the MPC extracts the output of the transaction execution, decodes it per the request's `outputDeserializationSchema`, and re-serialises the decoded values per its `respondSerializationSchema` (both given in the **SignBidirectionalEvent** it reacted to in step **2.**), applying the native Midnight standard library serialisation protocol.
    - **Foreign transaction failure:** there is no output to serialise, so the serialised output is instead the fixed 5-byte failure payload `deadbeef01` (see [Handling Failure](#handling-failure)).
  - From here the two branches converge: the MPC creates the attestation as the ECDSA signature over the attestation digest `upgradeFromTransient(transientHash([requestId, serializedOutput]))` (see [`calculateSignetAttestationDigest`](./packages/signet-midnight/src/Signet.compact#L311)) of whichever serialised output the branch produced, signed with the integrating contract's own **Response Signing Key** (see [Derived Keys](#derived-keys)).
  - The output attestation is then made available on Midnight with the MPC calling the [`respondBidirectional`](./packages/signet-contract/src/signet-contract.compact#L78) circuit on the **Sig Network Singleton**, emitting a **[RespondBidirectionalEvent](./packages/signet-midnight/src/Signet.compact#L302)**. Neither the digest nor the output itself travels on chain: the event carries only the attesting signature.
- **5.** The integrating dApp collects the execution output and its attestation and submits both back to the integrating contract, completing the cross chain interaction.
  - The dApp extracts the posted output attestation from the emitted **RespondBidirectionalEvent**.
  - It then reconstructs the exact serialised output the MPC attested, mirroring step **4.**'s branch:
    - **Foreign transaction success:** the dApp obtains the actual execution output off chain (see the output recovery note below: it broadcast the transaction in step **3.**, so it can read the result) and serialises it exactly as the MPC did in step **4.**, running the same two schema conversions, so the bytes match the attested ones byte for byte.
    - **Foreign transaction failure:** there is no output to obtain, and the serialised output is exactly the fixed 5-byte failure payload from step **4.**, at exactly that width.
  - It submits the attestation and the reconstructed serialised output to a completing circuit on the integrating contract (`completeCrossChain(...)` in the diagram), which recomputes the attestation digest from the output bytes and verifies the MPC's signature in-circuit via [`verifyRespondBidirectionalEvent`](./packages/signet-midnight/src/Signet.compact#L331) against the response key the contract pinned after deploy (see [Derived Keys](#derived-keys)). Success and failure verify identically, since step **4.** attests both with the same digest construction and key.
  - The completing circuit settles by the same distinction: when the verified output bytes equal the 5-byte failure payload exactly, it concludes the foreign transaction failed and reacts accordingly, and otherwise it treats them as a success, deserialising them against its respond serialisation schema ([`isMpcFailureOutput`](./packages/signet-midnight/src/constants.ts#L38) is the off-chain twin of that check). **Warning:** a contract whose successful serialised output could itself equal the failure payload cannot tell success from failure at all: see [Handling Failure](#handling-failure) for what types of respond schemas are vulnerable and how to protect against it.

> **Output recovery:** how the client reads the execution output is chain-specific. For EVM chains it is the mined call's return data, extracted with `debug_traceTransaction` (callTracer, top call frame), the same RPC method the MPC observes executions with. For local development, clients without trace access can fetch the raw output from the fakenet responder's helper API at `GET /responses/{requestId}` (served by [`ResponsesApi.ts`](https://github.com/sig-net/solana-signet-program/blob/fakenet-v0.18.0/fakenet-signer/src/server/ResponsesApi.ts), port 3040 in the local stack, consumed here by [`packages/integration-tests/src/fakenet-responses.ts`](packages/integration-tests/src/fakenet-responses.ts)). The fetched bytes are untrusted until step 5's in-circuit signature verification.

## Sign Bidirectional Event Discovery & Verification

The MPC receives notification of pending **SignBidirectionalEvent** signature requests via versioned `SignBidirectionalEventNotification` events emitted by the Sig Network Singleton contract. The v1 payload of this notification contains:
- `callerAddress` to locate the caller contract
- `requestsPathDepth` and `requestsPath` to locate the `signBidirectionalEventMap` in its ledger storage (see [The Request Map's Ledger-Tree Path](#the-request-maps-ledger-tree-path)).

The **RequestId** itself is not part of the payload: it is `signBidirectional`'s own first argument, disclosed in the same emitted event.

The MPC only generates signatures for **Verified Request Events**, which it discovers as follows:
- it picks up a notification event emitted by the Sig Network Singleton contract
- it confirms the notification event was emitted by a cross contract invocation of the `signBidirectional` circuit (direct invocations outside cross contract calls are ignored)
- it confirms the cross contract caller address equals the `callerAddress` in the notification
- it reads the `SignBidirectionalEvent` from ledger state at the `callerAddress`
- it confirms the `sender` in the `SignBidirectionalEvent` matches the `callerAddress` from the notification
- it confirms the read `SignBidirectionalEvent` hashes back to the notified **RequestId**

If any of these checks fail the request is dropped silently.

## Derived Keys

Every key the MPC uses is derived for the **requesting contract** and a **path**. There are two kinds: the *request signing key*, whose path each contract chooses, and the *response signing key*, whose path is fixed by the protocol. Both key derivations are **scoped by the address** of the requesting contract.

### Request Signing Key

The key the MPC signs requested foreign transactions with:

`requestSigningKey = f(mpcRootKey[keyVersion], caip2ChainId, contractAddress, hex::encode(path))`

The path is 32 opaque bytes of the contract's choosing (e.g. a fixed literal for a contract-owned account like "vault" or a hash of a caller's secret for per-user accounts). There are no format requirements: any 32 bytes are valid. **CRITICAL:** the MPC renders the path as `hex::encode(path)` before it derives the key: lowercase hex of the full 32 bytes, no trimming, no `0x` prefix. The contract address is always part of the derivation, so no contract can reach another contract's derived keys.

### Response Key

The key the MPC signs remote execution attestations with when posting them back to Midnight:

`responseKey = f(mpcRootKey[keyVersion], caip2ChainId, contractAddress, "midnight response key")`

The same derivation, but with the path fixed to the literal `"midnight response key"`, giving each contract one well-known response key. This fixed path is a protocol string that enters the derivation verbatim (no hex rendering, unlike a request's 32 path bytes). A contract pins its own response key in its ledger after deploy and verifies every response against it in-circuit (step 5 of the flow above).

> **keyVersion** is the version of the MPC root key that the derivation starts from. Current deployments use version `1`.
>
> **caip2ChainId** is the id of the chain the request originates from, in [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) form. For signature requests made on Midnight it is the Midnight variant (currently `midnight:testnet`). It is not the target chain id carried in the request record's `caip2Id` field.

## Handling Failure

A failed foreign transaction (one that reverted on chain, or whose nonce another transaction consumed) still completes the flow, through the same steps as a success: the MPC attests a **fixed failure payload** in step **4.**, the dApp submits it in step **5.**, and the integrating contract settles against it in-circuit.

- **The failure payload** is the 5 bytes `deadbeef01`: the magic error marker `0xdeadbeef` followed by one `0x01` byte, the same width regardless of the request's respond serialisation schema. It is [`MPC_FAILURE_OUTPUT`](./packages/signet-midnight/src/constants.ts#L29) in this library, originating in the MPC node's [`MAGIC_ERROR_PREFIX`](https://github.com/sig-net/mpc/blob/e180584f60c6e44819d0847687589370d2d8d2ee/chain-signatures/node/src/respond_bidirectional.rs#L24) and [`process_failed_tx`](https://github.com/sig-net/mpc/blob/e180584f60c6e44819d0847687589370d2d8d2ee/chain-signatures/node/src/respond_bidirectional.rs#L141).
- **The attestation carries no success flag.** Success and failure are signed identically: the same attestation digest formula `upgradeFromTransient(transientHash([requestId, serializedOutput]))`, the same **Response Signing Key**. The only signal of the outcome is the serialised output the signature verifies over.
- **Settlement must route on the verified bytes**: a foreign transaction failed when the verified output equals the failure payload exactly ([`isMpcFailureOutput`](./packages/signet-midnight/src/constants.ts#L38) is the off-chain twin of that check). The best way to route the two outcomes is Compact's fixed-width `Bytes<n>` circuit arguments: ensure the respond schema's packed width is not 5 bytes, then expose two settle circuits, one taking the schema's `Bytes<n>` for success and one taking `Bytes<5>` for failure, asserting exact equality with the failure payload. Every attested output then type-fits exactly one of the two.

> **Warning:** if `deadbeef01` is a valid successful serialised output for your contract, the contract cannot tell success from failure!

### Which Contracts Are Vulnerable

The MPC does not reserve the failure payload: a success whose output genuinely serialises to `deadbeef01` is attested with exactly those bytes (see the MPC node's [`process_success_tx`](https://github.com/sig-net/mpc/blob/e180584f60c6e44819d0847687589370d2d8d2ee/chain-signatures/node/src/respond_bidirectional.rs#L175)). Guarding against the ambiguity is the integrating contract's responsibility, through its respond serialisation schema:

- **Any packed width other than 5 bytes is fully safe.** The attestation digest covers the output at its full length, so a success attestation and a failure attestation can never verify over each other's output.
- **A packed width of exactly 5 bytes is vulnerable.** A prefix check is not safe (a legitimate output can begin `0xdeadbeef`), so the contract would have to recompute both candidate digests and check which one the MPC attested. For a genuine success output equal to `deadbeef01` even that fails: the two attestations are byte-identical, indistinguishable to the contract, the dApp and every observer. A contract that refunds on failure would then refund a transaction that actually executed.

**The rule: never give a request a respond serialisation schema that packs to exactly 5 bytes.** If one is truly unavoidable, either ensure the legitimate output domain excludes `deadbeef01`, or design settlement so either interpretation of that value is safe.

A worked example of getting this right is the [erc20-vault contract](https://github.com/sig-net/midnight-examples/blob/main/examples/erc20-vault/contract/src/erc20-vault.compact) in the examples repository. Its respond schemas pack to 1 byte (a transfer's bool) or 8 bytes (a uint64 amount), never 5 bytes, so an attested success only type-fits its `complete*` settle circuits (`Bytes<1>` / `Bytes<8>`). Its four refund circuits share one failure gate, `assertAttestedFailureOutput`, which takes `Bytes<5>` and asserts the exact payload bytes, so only a genuine failure attestation can settle as a refund.

# Integrator Guide

A signet-compliant client contract does four things:

- it stores its requests in a public `SignBidirectionalEventMap` in its own ledger
- it pins its counterparties: the Signet singleton contract and its own MPC response key
- it submits signature requests
- it verifies execution responses in-circuit

Integrating a contract on Midnight with the Sig Network MPC consists of:

- 4 once-off **setup** steps
- 5 per-request **runtime** steps that drive the full sign bidirectional flow

## Setup

Set up your contract for integration with the Sig Network MPC's sign bidirectional flow:

1. Add the protocol library to your project:
   ```sh
   yarn add @sig-net/midnight   # or: npm install @sig-net/midnight
   ```

2. Import the Signet module at the top of your contract (resolved through `node_modules` via `COMPACT_PATH`):
   ```compact
   import "@sig-net/midnight/src/Signet";
   ```

   Then tell the compact compiler about the npm packages with its `COMPACT_PATH` environment variable at compile time:
   ```sh
   COMPACT_PATH=node_modules compact compile --feature-zkir-v3 src/my-contract.compact src/managed/my-contract
   ```

   The Compact toolchain requirements in [Prerequisites](#prerequisites) apply to integrators too: compile with the pinned compiler version (currently `compact update 0.33.0-rc.2`) and always pass `--feature-zkir-v3`, as above.

3. Declare the required Sig Network protocol state in your ledger (plus recommended deployer identity and initialisation state). The event map can sit at ANY ledger field. Each notification that your contract emits declares the stored request's id and carries the map's resolved ledger-tree path (see [The Request Map's Ledger-Tree Path](#the-request-maps-ledger-tree-path)), and the MPC looks the authenticated request up there by that id.

   ```compact
   // Required: Map of SignBidirectionalEvent signature requests, configured by transaction type.
   // Configured and sized here for an EVM Type 2 transaction with
   // <1 calldata word, 0 access-list entries, 0 storage keys> and
   // 34-byte serialisation schemas.
   export ledger signBidirectionalEventMap: SignBidirectionalEventMap<EvmType2TxParams<1, 0, 0>, 34, 34>;

   // Required: The Signet singleton signer interface, set at deploy.
   // Used to notify the MPC of events you add to your signBidirectionalEventMap.
   sealed ledger signetSigner: SignetSigner;

   // Required: This contract's MPC response key, set in step 4.
   // Used to verify RespondBidirectionalEvents attesting the serialised output of foreign chain execution.
   export ledger mpcResponseKey: Secp256k1Point;

   // Recommended: contract-local source of request nonces, so identical
   // requests hash to distinct request ids. Nothing off-chain reads it.
   export ledger signetRequestNonce: Counter;

   // Recommended: used in step 4 to ensure initialisation runs only once.
   export ledger initialised: Counter;

   // Recommended: set on deploy, used in step 4 to ensure only the deployer may set the mpcResponseKey.
   sealed ledger deployer: Bytes<32>;

   // Recommended: supplies the deployer's identity secret from private state
   // off-chain. Only its commitment (below) ever reaches the ledger.
   witness witnessDeployerSecretKey(): Bytes<32>;

   // Recommended: the deployer identity commitment scheme. Exported so deploy
   // tooling can compute the constructor argument by calling the compiled circuit.
   export pure circuit calculateDeployerCommitment(sk: Bytes<32>): Bytes<32> {
     return upgradeFromTransient(transientHash<Vector<2, Bytes<32>>>([pad(32, "my-contract:deployer:"), sk]));
   }

   // Required: set signet contract and (recommended) deployer commitment on deployment.
   constructor(signetContract: SignetSigner, deployerCommitment: Bytes<32>) {
     signetSigner = disclose(signetContract);
     deployer = disclose(deployerCommitment);
   }
   ```

4. Set the contract's MPC response key once, right after deploy. Deriving this key requires the address of the contract, which only exists after deploy (see [Response Key](#response-key)):

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

## The Request Map's Ledger-Tree Path

Each notification must tell the MPC where your `signBidirectionalEventMap` sits in your contract's compiled on-chain state, so the MPC can read the authenticated request out of raw contract state. The location is a path in the state tree, passed to `constructSignBidirectionalEventNotificationV1` as two arguments:

- `requestsPathDepth`: the number of meaningful entries in the path (1 to 4).
- `requestsPath`: the path itself, zero padded to 4 entries.

The path shape comes from how compactc lays out state. The compiler packs a contract's public ledger fields into a tree whose array nodes hold at most 15 entries. With 15 or fewer fields, field N sits directly in the root array, at path `[N]` (depth 1). With more than 15 fields, the compiler groups the fields into segments of at most 15 (the remainder segment first) and the root array holds the segments. Each grouping adds one level to the tree and one entry to every field's path. A 20-field contract splits 5 + 15: field 4 sits at `[0, 4]` and field 19 sits at `[1, 14]` (depth 2).

Do not derive the path by hand: the compiler records it in your compiled artifacts. Compile your contract, then look up your map's `"index"` in `managed/<contract>/compiler/contract-info.json` (a bare number `4` means path `[4]`). The generated `managed/<contract>/contract/index.js` accessors walk the same indices, for example `state.asArray()[1].asArray()[14]` for a map recorded at `[1, 14]`. That path packs as `requestsPathDepth = 2` and `requestsPath = [1, 14, 0, 0]`.

The two caller contracts in this repository are worked examples of each case:

- [`packages/test-caller-contract`](packages/test-caller-contract): the flat case, where its 8-field ledger stores the map at field 4, so notifications carry depth `1` and path `[4, 0, 0, 0]`.
- [`packages/test-caller-contract-20-field`](packages/test-caller-contract-20-field): the chunked case, where its 20 fields split 5 + 15, so the map at field 19 packs as depth `2` and path `[1, 14, 0, 0]`.

## Runtime

Each interaction with your contract that executes a transaction on a foreign chain runs these 5 steps.

Steps 1 and 5 are circuits on your contract, and steps 2 to 4 are off-chain client code built on the utilities in `@sig-net/midnight`.

The off-chain steps share one `SignetRequestResponseReader` over your contract / Signet singleton pair, and the expected signer of the requested transaction (the key the MPC derives for your contract and the request's path, see [Derived Keys](#derived-keys)):

```ts
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
   asciiPadded,
   bytesToHex,
   deriveEvmAddress,
   signetEventSourceFromPublicDataProvider,
   SignetRequestResponseReader,
} from "@sig-net/midnight";

// Provider to index Midnight Blockchain
const publicDataProvider = indexerPublicDataProvider({
   queryURL: indexerUrl,
   subscriptionURL: indexerWsUrl
});

// SignetRequestResponseReader to poll for Signed Transactions and Signed RespondBidirectionalEvents
const reader = new SignetRequestResponseReader({
   // Address of YOUR deployed contract
   requesterContractAddress: myContractAddress,

   // signBidirectionalEventMap's ledger-tree path (see The Request Map's Ledger-Tree Path)
   requesterRequestsPath: [0],

   // Address of the Signet singleton contract
   signetContractAddress,

   // Raw contract state reads (your contract's request map)
   publicDataProvider,

   // The MPC's responses are read from the contract events the Signet
   // singleton emits, through the same provider
   eventSource: signetEventSourceFromPublicDataProvider(publicDataProvider),
});

// The path argument is the MPC's rendering of the exact 32 path bytes the
// contract stores in its requests, here pad(32, "my-path") (see Derived Keys).
const expectedSigner = deriveEvmAddress(
   mpcRootPublicKey,
   myContractAddress,
   bytesToHex(asciiPadded("my-path", 32)),
);
```

> **mpcRootPublicKey** is the root public key of the MPC network. On a local stack there is no fixed value: this repository's [integration-test setup](packages/integration-tests) generates a fresh `MPC_ROOT_KEY`, prints it during setup and appends it to the repo-root `.env`. For the public networks (stagenet, preview, preprod, mainnet) the fixed values are published in `@sig-net/midnight` via `getMpcRootPublicKey` (placeholders until each network's key is published).
>
> **signetContractAddress** is the address of the deployed Signet singleton contract. On a local stack the same setup deploys a fresh singleton, prints the address as `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` and appends it to `.env`. For the public networks the addresses are published in `@sig-net/midnight` via `getSignetContractAddress` (placeholders until each deployment lands).

1. Store a signature request and notify the MPC via cross contract call. Build (or overwrite) every part of the transaction your contract enforces in-circuit, calldata above all (see [EVM Type 2 Transactions and ABI Calldata Words](#evm-type-2-transactions-and-abi-calldata-words)). Never pass caller input through unchecked:

   ```compact
   // Construct SignBidirectionalEvent signature request and calculate its RequestId
   const request = constructSignBidirectionalEvent<EvmType2TxParams<1, 0, 0>, 34, 34>(/* ... */);
   const requestId = disclose(calculateRequestId<EvmType2TxParams<1, 0, 0>, 34, 34>(request));

   // Store the signature request in your signBidirectionalEventMap for MPC to discover
   signetRequestNonce.increment(1);
   signBidirectionalEventMap.insert(requestId, disclose(request));

   // Notify the MPC of the SignBidirectionalEvent and the location of your signBidirectionalEventMap.
   // The map is at ledger field 0 (Setup step 3), so its path is [0] at depth 1
   // (see The Request Map's Ledger-Tree Path).
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

2. Poll the Signet singleton for the MPC's signature response. The singleton emits each response as a contract event that carries the request id it answers beside the signature. The id is unauthenticated routing data: it scopes the read to your request's posts and proves nothing. The event log is unauthenticated (anyone can post under any id), so use the verifying getter. It only returns a post whose signature recovers to `expectedSigner` over the signing hash of the requested transaction:

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

4. Poll the Signet singleton for the MPC's attestation of the remote execution output. The MPC posts it once it observes the transaction execute on the foreign chain, and the singleton emits it as a contract event that carries the request id beside the MPC's signature. Both the attestation digest and the serialised output travel off chain (you broadcast the transaction in step 3, so you can read its result). The event log is unauthenticated, so use the verifying getter, as in step 2. It reads your request's posts by id, recomputes the digest over the output that you present, and only returns a post whose signature verifies against the response key of your contract.

   ```ts
   const respondBidirectionalEvent = await reader.getVerifiedRespondBidirectionalEvent(
      requestId,
      serializedOutput,
      mpcResponseKey,
   );
   // undefined: no attestation of that output posted yet, poll again.
   ```

5. Deliver the response and the serialised output to your contract, which recomputes the attestation digest, verifies the event in-circuit against the response key pinned in Setup step 4, and consumes the request. The width argument is the exact packed size of your respond serialisation schema (a single bool packs to 1 byte):

   ```compact
   assert(
      verifyRespondBidirectionalEvent<1>(requestId, serializedOutput, respondBidirectionalEvent, mpcResponseKey),
      "Invalid attestation signature"
   );
   signBidirectionalEventMap.remove(requestId);
   ```

   A foreign transaction that never executed settles through the same verification at the failure payload's own 5-byte width. Route by width and exact bytes, and never choose a respond schema that packs to exactly 5 bytes: see [Handling Failure](#handling-failure).

## EVM Type 2 Transactions and ABI Calldata Words

An `EvmType2TxParams` request decomposes the EVM transaction into typed fields, so your contract can enforce each field in-circuit. Its optional `calldata` is an `EvmCalldata<maxWords>`: the 4-byte function selector plus a list of 32-byte ABI words, per the [Solidity ABI spec](https://docs.soliditylang.org/en/latest/abi-spec.html). Slots past `noWords` are unused capacity and never reach the transaction.

Every word must be stored in canonical ABI form (big-endian). The MPC signs a transaction whose calldata is exactly `selector || words[0..noWords]`, byte for byte. A word stored in any other form becomes a signed transaction that calls the foreign contract with garbage arguments. Compact's integer casts are little-endian, so do not hand-roll the byte order. Build every word with the module's helper circuits, and read words back with the matching readers.

| Solidity type | Build with | Read back with |
|---|---|---|
| `address` | `evmAddressAbiWord(addr: Bytes<20>)` | |
| unsigned integers up to `uint128` (amounts, ids) | `numericAbiWord(value: Uint<128>)` | `abiWordToUint128(word)` |
| `bool` | `boolAbiWord(value: Boolean)` | `abiWordToBool(word)` |

### Example: An ERC20 Transfer

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

### Example: A Bool Argument, and Decoding a Bool Result

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

The same builders and readers exist as TypeScript twins under identical names, for composing expected words off-chain (UIs, expected-record builders, tests). The `@sig-net/midnight` test suite keeps them in lockstep with the compiled circuits.

## More Examples

For full integration examples (such as an ERC20 cross chain vault) see the [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples) repository.

# Contributor Guide

First install the [Prerequisites](#prerequisites), then get set up for contributing by getting both test layers green: the offline unit tests, then the end to end integration suites.

Every change must also pass the linter and the formatter, which CI enforces on every pull request. One ESLint flat config (`eslint.config.js`) and one Prettier config (`.prettierrc.json`) at the repo root cover all packages, so there is nothing to configure per package. In VS Code, install the two recommended extensions the editor offers on first open (`dbaeumer.vscode-eslint` and `esbenp.prettier-vscode`) and both run on save.

## Compiling, Building and Running Unit Tests

Packages can be compiled (with or without generating zk keys), built and unit tested either independently or together. Only the packages with contracts that run in integration tests have a zk compile option. Unit tests run offline against a simulated Midnight runtime, so zk keys are not needed before running them. 

From the root of the repository:

```sh
# Install all dependencies for all workspace members once to start.
# Run this from the repository root.
yarn install

## --- Compile, build or test: All Packages (whole workspace, from repository root) ---

# Quick compile: all packages (checks syntax and generates circuits)
# Runs the compact compiler for each package without generating zk keys (compiler output in the package's src/managed/)
yarn compile

# Longer compile: all packages that require zk keys (checks syntax, generates circuits and zk keys)
# Runs the compact compiler with zk keys for each package that has a :zk option (compiler output in the package's src/managed/)
yarn compile:zk

# Test: all packages (typecheck + unit tests: offline simulator-only)
# Requires 'yarn compile' to have been run (zk keys not required for unit testing).
yarn test

# Build: all packages
# Requires both 'yarn compile' and 'yarn compile:zk': packages that ship
# zk keys refuse to build without them.
yarn build

## --- Linting and formatting: All packages (whole workspace, from repository root) ---

# Check formatting (Prettier). Needs nothing compiled.
yarn format:check
yarn format        # rewrite files in place

# Lint (ESLint + typescript-eslint, type-aware).
# Requires 'yarn compile': the rules read the generated src/managed/ types,
# the same reason 'yarn build' needs it.
yarn lint
yarn lint:fix      # apply every autofix

## --- Compile, build or test a single package independently ---

# The @sig-net/midnight-contract package:
yarn compile:signet-contract
yarn compile:signet-contract:zk  # generates signet-contract zk keys
yarn test:signet-contract        # requires at least 'yarn compile:signet-contract'
yarn build:signet-contract       # requires 'yarn compile:signet-contract:zk'

# The @sig-net/midnight SDK package:
yarn compile:signet-midnight  # NOTE: no :zk option
yarn test:signet-midnight     # requires 'yarn compile:signet-midnight'
yarn build:signet-midnight    # requires 'yarn compile:signet-midnight'
```

> **NOTE:** A build error about missing prover keys (for example "no prover keys in src/managed/keys") means the package's zk compile has not been run yet: run the associated `compile:...:zk` script to generate them.

## Integration Tests

Two end to end suites run against the local docker stack. The generic suite drives the smallest possible client (the test caller [contract](./packages/test-caller-contract/src/test-caller-contract.compact)) through the protocol: submit a signature request, get discovered via the signet contract's notification events, receive the MPC signature, and verify it in-circuit. The real-EVM suite carries on past signing: it broadcasts the signed call to the local anvil chain, lets the fakenet observe the mined execution and post its attestation, fetches the raw output from the fakenet's `/responses` helper API, picks the attestation that verifies over the bytes it recomputed, and verifies it in-circuit. Get them running locally:

1. Ensure you have all of the [prerequisites](#prerequisites) installed.
2. From the repository root, install workspace dependencies, select the required Compact toolchain explicitly, and compile:
   ```sh
   corepack enable
   yarn install
   compact update 0.33.0-rc.2   # Exact version required.
                                # `compact update` installs/downgrades
                                # to stable.
   yarn compile
   ```
3. Start the local stack (Midnight node, indexer, proof server, anvil EVM) with `docker compose up -d`. The fakenet MPC responder is started automatically by the test setup once the signet contract is deployed.
4. Run the suites and watch them go. The first run can take **~10–25 minutes** (it generates zk proving keys for both contracts, deploys them and hands off to the fakenet responder, all automatically, no `.env` inserts needed):
   ```sh
   yarn test:integration-tests                          # both suites, requires 'yarn compile'
   yarn test:integration-tests:signet-caller-e2e        # generic caller flow only, requires 'yarn compile'
   yarn test:integration-tests:signet-caller-evm-e2e    # real-EVM flow only, requires 'yarn compile'
   ```
   Whichever selection you run, the setup pipeline runs first (narrowing the selection never skips setup). Green looks like every test in the selected flow files passing. Afterwards, save the printed `MIDNIGHT_CALLER_CONTRACT_ADDRESS` into `.env` so the next run skips compile and deploy (~2 minutes). The signet contract address is appended to `.env` automatically.

**TIP:** If you are using Claude Code you can ask it to do all of this for you using this [skill](.claude/skills/e2e/SKILL.md), for example:
```
Use your /e2e skill to get the integration suite running for me, from fresh clone to green. Recover the run yourself if anything fails along the way.
```

**NOTE:** The most common reason that a run fails is the proof server hanging or crashing when it exhausts memory on a proving leg. This most often presents as the test failing with `connect ECONNREFUSED 127.0.0.1:6300`, with `docker ps -a` showing the proof server container as `Exited (137)`, i.e. OOM-killed. If this happens, restart the proof server and rerun. With the contract addresses kept in `.env` the rerun skips straight to the flow.

# Prerequisites

| Prerequisite | Version | Check With | Where to Get It |
| ------- | ------| ------  |----------- |
| Node | ≥ 20 (22+ recommended) | `node --version` | [nodejs.org](https://nodejs.org) or your version manager (nvm, fnm, …) |
| Yarn 4 (via Corepack) | 4.x | `corepack enable && yarn --version` | Corepack ships with Node, and the repo's `packageManager` field pins the Yarn version |
| Compact toolchain | compiler 0.33.0-rc.2, invoked with `--feature-zkir-v3` (see note) | `compact compile --version` → `0.33.0` | Install the `compact` launcher per [Midnight's docs](https://docs.midnight.network/), then `compact update 0.33.0-rc.2` (compiler builds live at [LFDT-Minokawa/compact releases](https://github.com/LFDT-Minokawa/compact/releases)). If the launcher refuses the rc version, use the direct-download recipe in [.github/workflows/ci.yml](.github/workflows/ci.yml) |
| A docker environment | any recent engine | `docker --version` | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS/Windows) or your distro's engine, with **≥ 16 GB RAM allocated** (see note) |
| Docker Compose v2 | ≥ 2.x | `docker compose version` | Included with Docker Desktop (plugin package on Linux) |

**NOTE:** every `compact compile` against this stack must pass the `--feature-zkir-v3` flag: it is part of the pinned ledger-9 matched set (compiler, node, indexer, proof server), and output compiled without it is not compatible with that stack. This repository's compile scripts already pass it. Integrators compiling their own contracts must pass it themselves (as shown in the [Integrator Guide](#integrator-guide)).

**NOTE:** the midnight proof server is quite heavy. It is recommended that you allocate at least 16 GB of RAM to your docker environment, otherwise expect to have to restart the tests as the proof server hangs.

## Matched Set

These versions move together. Bumping one alone produces a stack that compiles but does not interoperate, and the failure is usually silent: a responder that does not recognise a request simply never answers it.

| Component | Version | Pinned in |
| ------- | ------ | ------ |
| `@sig-net/*` npm packages | 0.21.0-rc.2 | [`packages/*/package.json`](packages) |
| fakenet MPC responder | `ghcr.io/sig-net/fakenet:0.18.0` | [`docker-compose.yaml`](docker-compose.yaml) |
| Compact compiler | 0.33.0-rc.2, invoked with `--feature-zkir-v3` | [`.github/workflows/ci.yml`](.github/workflows/ci.yml), [`.github/workflows/publish.yml`](.github/workflows/publish.yml), [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) |
| Midnight node | 2.0.0-rc.4 | [`docker-compose.yaml`](docker-compose.yaml) |
| Midnight indexer | 4.4.0-pre-alpha.16 (`l91r3-n2r3` build) | [`docker-compose.yaml`](docker-compose.yaml) |
| Midnight proof server | 9.0.0-rc.5_experimental | [`docker-compose.yaml`](docker-compose.yaml) |
| `@midnightntwrk/ledger-v9` | 1.0.0-rc.3 | [`package.json`](package.json) resolutions |

**NOTE:** each fakenet release names the `@sig-net` version it was built against ([`fakenet-v*` tags](https://github.com/sig-net/solana-signet-program/tags)). `fakenet:0.18.0` is built against 0.21.0-rc.2 and serves the public `/responses/{requestId}` helper API on port 3040 (mapped by [`docker-compose.yaml`](docker-compose.yaml)), from which the integration tests fetch each request's raw traced EVM output.

# Packages

| Package | npm | What it is |
|---|---|---|
| [`packages/signet-midnight`](packages/signet-midnight) | `@sig-net/midnight` | Client-agnostic signet protocol library: shared Compact modules, TS twins of the wire structs, state readers, event decoders, request feed, crypto (epsilon derivation, secp256k1 ECDSA attestations) |
| [`packages/signet-contract`](packages/signet-contract) | `@sig-net/midnight-contract` | The central singleton contract: emits unverified request-notification and response events |
| [`packages/signet-contract-deploy`](packages/signet-contract-deploy) | `@sig-net/midnight-contract-deploy` | Deploy tooling for the singleton + the generic deploy/wallet plumbing |
| [`packages/midnight-serde`](packages/midnight-serde) | `@sig-net/midnight-serde` | TypeScript twin of Compact's builtin `serialize<T,N>`/`deserialize<T,N>` byte layout, pinned byte-for-byte against compiled fixture circuits. Zero runtime dependencies |
| [`packages/test-caller-contract`](packages/test-caller-contract) | repo-private | Integration-testing caller contract: submit a signature request, verify the response, the smallest thing that drives the protocol. Testing only, not an integration example |
| [`packages/test-caller-contract-20-field`](packages/test-caller-contract-20-field) | repo-private | Integration-testing caller contract: the 20-field lockstep fixture proving the raw ledger readers resolve field numbers through the compiler's chunked (>15-field) state layout. Testing only |
| [`packages/integration-tests`](packages/integration-tests) | repo-private | The generic e2e suite: submit → notification → MPC signature → in-circuit verify, against the local docker stack (`docker-compose.yaml`: midnight node/indexer/proof server + anvil EVM + fakenet MPC responder) |
| [`packages/lib`](packages/lib) | repo-private | Shared midnight-js provider adapters |
