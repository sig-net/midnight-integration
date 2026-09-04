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
- [Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide): the once-off setup and the per-request runtime steps, built on this package's exports.
- [EVM Type 2 transactions and ABI calldata words](https://github.com/sig-net/midnight-integration/blob/main/README.md#evm-type-2-transactions-and-abi-calldata-words): building calldata words in-circuit and deserialising respond payloads.

Full integration examples (such as an ERC20 cross chain vault) live in [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

## Export highlights

The exports you reach for when integrating, by task. The setup and runtime step numbers refer to the [Integrator Guide](https://github.com/sig-net/midnight-integration/blob/main/README.md#integrator-guide).

### Compact module

What your contract imports with `import "@sig-net/midnight/src/Signet"`:

| Task | Exports |
|---|---|
| Declare the protocol ledger state (setup step 3) | `SignBidirectionalEventMap` (the request map the MPC reads) and `SignetSigner` (the Signet singleton's cross-contract-call interface, pinned at deploy). |
| Build and store a signature request (runtime step 1) | `constructSignBidirectionalEvent` and `calculateRequestId`, over the request structs `EvmType2TxParams`, `EvmCalldata` and `EvmAccessListEntry`. |
| Notify the MPC of the request (runtime step 1) | `constructSignBidirectionalEventNotificationV1`: packs your contract's address and the request map's ledger-tree path. |
| Build and read calldata words in-circuit | The builders `evmAddressAbiWord`, `numericAbiWord` and `boolAbiWord`, and the readers `abiWordToUint128` and `abiWordToBool` (see [EVM Type 2 transactions and ABI calldata words](https://github.com/sig-net/midnight-integration/blob/main/README.md#evm-type-2-transactions-and-abi-calldata-words)). |
| Verify the execution attestation (runtime step 5) | `verifyRespondBidirectionalEvent`: recomputes the attestation digest from the output bytes and checks the MPC's signature against your pinned response key. |

### TypeScript library

What clients import from `@sig-net/midnight`:

| Task | Exports |
|---|---|
| Poll for the MPC's responses and verify them (runtime steps 2 to 4) | `SignetRequestResponseReader`: one reader per contract and Signet singleton pair. Its getters `getVerifiedSignatureRespondedEvent`, `getSignedEvmTransaction` and `getVerifiedRespondBidirectionalEvent` map to steps 2, 3 and 4. |
| Derive the key the MPC signs your requests with | `deriveEvmAddress`: the expected signer address checked in step 2 (see [Derived keys](https://github.com/sig-net/midnight-integration/blob/main/README.md#derived-keys)). |
| Derive the response key your deploy pins | `deriveMidnightResponseKey`: the key `initialise` stores (setup step 4), derived from your contract's address. |
| Look up published counterparty values | `MidnightNetwork`, `getMpcRootPublicKey` and `getSignetContractAddress`: the fixed per-network values (see the notes in [Runtime](https://github.com/sig-net/midnight-integration/blob/main/README.md#runtime)). |
| Compute a request id off chain | `calculateRequestId`: the TS twin of the on-chain circuit, plus `requestIdHex` and `parseRequestIdHex` for the hex form. |
| Compose expected calldata words off chain (UIs, expected-record builders, tests) | The builders `numericAbiWord`, `evmAddressAbiWord` and `boolAbiWord`, and the readers `abiWordToUint128` and `abiWordToBool`: TS twins of the circuits under identical names. |
| Convert a foreign execution output into respond bytes | `deserializeEvmOutput` (raw EVM return data to named values) and `serializeRespondOutput` (named values to the packed respond payload the MPC attests): together they rebuild the `serializedOutput` of steps 4 and 5. |
| Recognise a failed remote execution | `MPC_FAILURE_OUTPUT` and `isMpcFailureOutput`: the MPC's fixed 5-byte failure payload for reverted or replaced transactions. |
| Verify attestations without the reader | `verifyRespondBidirectionalSignature`: the check the reader runs internally, exposed for custom pipelines. |
| Mint attestations in your contract's unit tests | The `@sig-net/midnight/testing` entry point, see [Testing entry point](#testing-entry-point). |
| Discover requests MPC-side (responders, background workers) | The discovery primitives: decode the signet contract's emitted notification events with `decodeSignBidirectionalEventNotificationPayload` and `decodeSignBidirectionalNotification`, then resolve each pointer against the named caller's own request map with `lookupSignetRequestAt` (the authenticated read). The polling loop belongs to the responder. |
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
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
} from "@sig-net/midnight/testing"; // tests only

// A real RespondBidirectionalEvent for (requestId, output), signed by secretKey.
// It verifies, in-circuit and off chain, against secp256k1PublicKeyOf(secretKey).
const event = {
  signature: ecdsaSignatureToMpcSignature(
    signAttestationDigest(
      calculateSignetAttestationDigest(requestId, serializedOutput),
      secretKey,
    ),
  ),
};
```

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the central signet contract this library reads from.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploy tooling for that contract plus generic Midnight deploy/wallet plumbing.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration).
