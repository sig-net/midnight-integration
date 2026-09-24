# @sig-net/midnight

The [Sig Network](https://sig.network) [Distributed MPC](https://github.com/sig-net/mpc) integration for the [Midnight blockchain](https://midnight.network) lets contracts on Midnight execute arbitrary transactions on foreign blockchains, and respond to the results of those transactions.

`@sig-net/midnight` is the client-agnostic protocol library for that integration. It carries everything a Midnight contract or off-chain client needs to speak the signet protocol (the MPC's [sign bidirectional flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-protocol-flow)). It does not bind to any particular contract.

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

- **TypeScript library** for clients off chain: readers that poll the signet contract and verify the MPC's responses, key derivation and attestation crypto, output serialisation, the published per-network addresses and constant values, and typed twins of the on-chain structs and circuits.

The [Export highlights](#export-highlights) section lists the specific exports each task uses.

## Install

```sh
npm install @sig-net/midnight
```

## Documentation

The protocol and integration documentation lives in the [sig-net/midnight-integration README](https://github.com/sig-net/midnight-integration/blob/main/README.md):

- [Sign Bidirectional Flow](https://github.com/sig-net/midnight-integration/blob/main/README.md#sign-bidirectional-protocol-flow): the 5-step protocol this package speaks, with diagram, failure handling and output recovery.
- [Derived keys](https://github.com/sig-net/midnight-integration/blob/main/README.md#derived-keys): the request signing key and the response key, and how the MPC derives them.
- [Handling Failure](https://github.com/sig-net/midnight-integration/blob/main/README.md#handling-failure): the empty output and failure output kind the MPC attests for a failed foreign transaction, and how a contract routes on the verified kind.
- [Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide): the once-off setup and the per-request runtime steps, built on this package's exports.
- [EVM Type 2 transactions and ABI calldata words](https://github.com/sig-net/midnight-integration/blob/main/README.md#evm-type-2-transactions-and-abi-calldata-words): building calldata words in-circuit and deserialising respond payloads.

Full integration examples (such as an ERC20 cross chain vault) live in [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

## Export highlights

The exports you reach for when integrating, by task. The setup and runtime step numbers refer to the [Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide).

### Compact module

What your contract imports with `import "@sig-net/midnight/src/Signet"`:

| Task | Exports |
|---|---|
| Declare the protocol ledger state (setup step 3) | `SignBidirectionalEventMapV1` (the request map the MPC reads) and `SignetSigner` (the Signet singleton's cross-contract-call interface, pinned at deploy). |
| Build and store a signature request (runtime step 1) | `constructSignBidirectionalEventV1` and `calculateRequestIdV1`, over the request structs `EvmType2TxParams`, `EvmCalldata` and `EvmAccessListEntry`. |
| Notify the MPC of the request (runtime step 1) | `constructSignBidirectionalEventNotificationV1`: packs your contract's address and the request map's ledger-tree path. |
| Build and read calldata words in-circuit | The builders `evmAddressAbiWord`, `numericAbiWord` and `boolAbiWord`, and the readers `abiWordToUint128` and `abiWordToBool` (see [EVM Type 2 transactions and ABI calldata words](https://github.com/sig-net/midnight-integration/blob/main/README.md#evm-type-2-transactions-and-abi-calldata-words)). |
| Verify the execution attestation (runtime step 5) | `verifyRespondBidirectionalEventV1`: recomputes the attestation digest from the output bytes and the posted request id, output kind and block height, and checks the MPC's signature against your pinned response key. |

### TypeScript library

What clients import from `@sig-net/midnight`:

| Task | Exports |
|---|---|
| Poll for the MPC's responses and verify them (runtime steps 2 to 4) | `SignetRequestResponseReader`: one reader per contract and Signet singleton pair. Its getters `getVerifiedSignatureRespondedEvent`, `getSignedEvmTransaction` and `getVerifiedRespondBidirectionalEvent` map to steps 2, 3 and 4. |
| Verify responses over events already in hand (explorers, anything that streams the history once) | Decode the stream once with `tryDecodeSignetEvent`, then `reader.verifySignatureRespondedEvents(requestId, expectedSigner, events)` and `findVerifiedRespondBidirectionalEvent(requestId, serializedOutput, mpcResponseKey, events)` judge a request's posts without another walk of the event history. `signetEventRecordsOf` is the routing step both share. |
| Derive the key the MPC signs your requests with | `deriveMidnightRequestSigningKey`: the request signing public key for a contract address and path, and `deriveEvmAddress`: that key's EVM address, the expected signer checked in step 2 (see [Derived keys](https://github.com/sig-net/midnight-integration/blob/main/README.md#derived-keys)). With a request record in hand, `deriveSignBidirectionalEventSigningKey` and `deriveSignBidirectionalEventSignerEvmAddress` take the record and render its `sender` and `path` into the derivation themselves. |
| Derive the response key your deploy pins | `deriveMidnightResponseKey`: the key `initialise` stores (setup step 4), derived from your contract's address. |
| Look up published counterparty values | `MidnightNetwork`, `getMpcRootPublicKey` and `getSignetContractAddress`: the fixed per-network values (see the notes in [Runtime](https://github.com/sig-net/midnight-integration/blob/main/README.md#runtime)). |
| Accept an MPC public key in any published spelling | `parseSecp256k1PublicKey` (to a Compact `Secp256k1Point`) and `normaliseSecp256k1PublicKey` (to the canonical `0x04…` uncompressed SEC1 hex): both take SEC1 hex, compressed or uncompressed with an optional `0x`, and NEAR's `secp256k1:<base58>`. |
| Read a text field of a request record | `asciiUnpadded`: the inverse of `asciiPadded`, for the zero-padded text fields (`executionDest`, the two schemas). |
| Compute a request id off chain | `calculateRequestId`: the TS twin of the on-chain circuit, plus `requestIdHex` and `parseRequestIdHex` for the hex form. |
| Compose expected calldata words off chain (UIs, expected-record builders, tests) | The builders `numericAbiWord`, `evmAddressAbiWord` and `boolAbiWord`, and the readers `abiWordToUint128` and `abiWordToBool`: TS twins of the circuits under identical names. |
| Convert a foreign execution output into respond bytes | `deserializeEvmOutput` (raw EVM return data to named values) and `serializeRespondOutput` (named values to the packed respond payload the MPC attests): together they rebuild the `serializedOutput` of steps 4 and 5. |
| Recognise a failed remote execution | `OutputKind` on the verified `RespondBidirectionalEvent`: `failed` or `unviable` beside an empty output (see [Handling Failure](https://github.com/sig-net/midnight-integration/blob/main/README.md#handling-failure)). |
| Read the attested output bytes from the MPC's output cache | `MpcOutputCacheReader`: one reader per network and Signet singleton pair, over the public bucket an MPC configured with output storage writes each request's exact attested bytes to before posting, defaulting to the bucket `getMpcOutputCacheUrl` publishes for the network. `fetchSerializedOutput` yields the bytes step 5 verifies, `undefined` while the object is not written yet. |
| Verify attestations without the reader | `verifyRespondBidirectionalSignature`: the check the reader runs internally, exposed for custom pipelines. |
| Mint attestations in your contract's unit tests | The `@sig-net/midnight/testing` entry point, see [Testing entry point](#testing-entry-point). |
| Discover requests MPC-side (responders, background workers) | The discovery primitives: decode the signet contract's emitted notification events with `decodeSignetEventNamed(event, SignetEventName.SignBidirectionalEvent)` (or every kind at once with `decodeSignetEvent`, which throws on an undecodable payload anyone can emit, or its non-throwing sibling `tryDecodeSignetEvent`), then resolve each pointer against the named caller's own request map with `lookupSignetRequestAt` (the authenticated read). The polling loop belongs to the responder. |
| Call the compiled protocol circuits | `pureCircuits`: the compiled circuits of `Signet.compact`, for example the notification packer. Off-chain code calls these compiled artefacts, so it always agrees with what the contracts prove. |

### Testing entry point

The package has two entry points. The root import, `@sig-net/midnight`, carries
everything a running integration needs: clients verify and decode posts, they
never sign them. The helpers that SIGN (mint a real attestation with a
throwaway secret key) live on `@sig-net/midnight/testing`, so a signing
function never sits beside the runtime API.

You need the testing entry in exactly one situation: unit testing a contract
whose circuit verifies an MPC attestation. The circuit needs a genuine record
to accept, and the testing helpers produce, with a throwaway key, the exact
record shape the MPC posts, so the claim path is testable in-process with no
stack and no MPC:

```ts
import { verifyRespondBidirectionalSignature } from "@sig-net/midnight"; // runtime
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing"; // tests only

// A real RespondBidirectionalEvent for (requestId, blockHeight, outputKind,
// serializedOutput), signed by secretKey: the request id, block height, kind,
// output width, attestation digest and signature the MPC would post. It
// verifies, in-circuit and off chain, against secp256k1PublicKeyOf(secretKey).
const event = attestRespondBidirectional(
  { requestId, blockHeight, outputKind, serializedOutput },
  secretKey,
);
```

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the central signet contract this library reads from.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploy tooling for that contract plus generic Midnight deploy/wallet plumbing.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration).
