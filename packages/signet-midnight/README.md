# @sig-net/midnight

The client-agnostic [Sig Network](https://sig.network) protocol library for the [Midnight blockchain](https://midnight.network), and the seed of a future signet.js Midnight adapter. It carries everything a Midnight contract or off-chain client needs to speak the signet protocol (the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional)) without binding to any particular contract.

## What is in it

- **Shared Compact modules**: the package ships its `.compact` sources, so contracts import them directly:
  ```compact
  import "@sig-net/midnight/src/Signet";
  ```
- **Compiled pure circuits** (`pureCircuits`): the executable reference implementation of the client-agnostic circuits (path/identity checks, the attestation message, the sign-bidirectional notification packer, the Schnorr challenge). Off-chain code calls these compiled artefacts instead of re-porting the algorithms, so it always agrees with what the contracts prove.
- **TypeScript twins of the wire structs** and signet request-id computation.
- **State readers, request feed and resolver**: poll the signet contract for pending requests and their signature / remote-execution responses.
- **Crypto helpers**: epsilon derivation and Jubjub Schnorr response verification.

Where signet.js already covers something (for example EVM transaction preparation or address derivation), import it from there; only what is Midnight-specific lives here.

## Derived keys

Every key the MPC signs with is scoped by the requesting contract:

`derivedSigningKey = f(mpcRootKey[keyVersion], contractAddress, path)`

The path is 32 opaque bytes of the contract's choosing (a fixed literal for a contract-owned account, a hash of a caller's secret for per-user accounts). There are no format requirements. The contract address is always part of the derivation, so no contract can reach another contract's derived keys.

## Install

```sh
npm install @sig-net/midnight
```

## How a client contract integrates

A signet-compliant client contract does four things:

1. **Stores requests in a public index**: a `SignBidirectionalRequestIndex` map in its ledger. The index can sit at ANY ledger field: each notification the contract registers names the field position holding it, and the MPC reads the authenticated request from there. A contract-local `SignetNonce` counter is a convenient source of request nonces (identical requests must hash to distinct ids); nothing off-chain reads it.
2. **Pins its counterparties at deploy time**: the central signet contract it notifies, and the MPC attestation key its verify circuit accepts.
3. **Submits signature requests**: builds the transaction decomposition in-circuit, constructs the canonical request record, stores it in its own index under the request id, and registers a notification in the central registry (which the MPC polls; the MPC then reads the authenticated request back from the ledger field the notification names).
4. **Verifies the execution response**: checks the attestation key, verifies the MPC's Schnorr attestation in-circuit over (request id, output), and consumes the request.

```compact
pragma language_version >= 0.25;

import CompactStandardLibrary;
import "@sig-net/midnight/src/Signet";

// (1) The request index: the public map the MPC reads requests back from.
// It can sit at any ledger field; the notification in submitSignatureRequest
// names its position (0 in this contract). The counter is contract-local
// (it sources each request's nonce so identical requests get distinct ids);
// the MPC never reads it. The generic size parameters cap the EVM calldata
// words, access list entries and storage keys your requests may carry.
export ledger signetRequestsIndex: SignBidirectionalRequestIndex<EVMType2TxParams<1, 0, 0>>;
export ledger signetNonce: SignetNonce;

// (2) Pinned at deploy time.
export sealed ledger mpcPubKeyHash: Bytes<32>;
sealed ledger signetNotifier: SignetNotifier;

constructor(mpcPk: JubjubPoint, signetContract: SignetNotifier) {
  mpcPubKeyHash = disclose(persistentHash<JubjubPoint>(mpcPk));
  signetNotifier = disclose(signetContract);
}

// (3) Construct, store and announce a signature request.
export circuit submitSignatureRequest(evmNonce: Uint<64>, keyVersion: Uint<32>): [] {
  // Decompose the EVM transaction to be signed. Build (or overwrite) every
  // part your contract enforces in-circuit, calldata above all; never pass
  // caller input through unchecked.
  const txParams = EVMType2TxParams<1, 0, 0> {
    to: pad(20, "recipient"),
    chainId: 31337 as Uint<64>,
    nonce: evmNonce,
    gasLimit: 100000 as Uint<64>,
    maxFeePerGas: 30000000000 as Uint<128>,
    maxPriorityFeePerGas: 1000000000 as Uint<128>,
    value: 0 as Uint<128>,
    accessListEntryCount: 0,
    accessList: [],
    calldata: none<EVMCalldata<1>>()
  };

  // The canonical request record. This variant signs with the CONTRACT's own
  // derived account (a path literal the contract fixes); use
  // constructSignBidirectionalRequest instead for caller-identity requests,
  // where the path is bound to the caller's identity commitment.
  const schema = pad(128, "[{\"name\":\"success\",\"type\":\"bool\"}]");
  const request = constructContractPathSignBidirectionalRequest<EVMType2TxParams<1, 0, 0>>(
    signetNonce as Uint<64>,      // contract-local request nonce
    TxParamType.evmType2,
    txParams,
    pad(32, "eip155:31337"),      // target chain (CAIP-2)
    keyVersion,                    // MPC root-key version (>= 1)
    pad(256, "my-treasury"),      // contract-owned derivation path
    pad(32, "ecdsa"),
    pad(32, "ethereum"),
    pad(64, ""),
    schema,
    schema
  );

  // Store the request in YOUR ledger under its id, then register the
  // notification in the central signet contract's registry. The final
  // argument is the ledger field position of signetRequestsIndex, which is
  // how the MPC finds the index to read the request back from.
  const requestId = disclose(calculateRequestId<EVMType2TxParams<1, 0, 0>>(request));
  assert(!signetRequestsIndex.member(requestId), "Request already exists");
  signetNonce.increment(1);
  signetRequestsIndex.insert(requestId, disclose(request));
  signetNotifier.notifyBidirectionalSignatureRequest(requestId,
    constructSignBidirectionalNotificationV1(kernel.self(), requestId as Bytes<32>, 0 as Uint<8>));
}

// (4) Verify the MPC's Schnorr-signed attestation of the remote execution
// and consume the request (double-verify protection).
export circuit verifyResponse(requestId: RequestId, respondBidirectional: RespondBidirectional): [] {
  const rid = disclose(requestId);
  assert(
    persistentHash<JubjubPoint>(respondBidirectional.pk) == mpcPubKeyHash,
    "Unauthorized: attestation pk is not the MPC key"
  );
  assert(
    jubjubSchnorrVerify<4>(
      signetAttestationMessage(rid, respondBidirectional.serializedOutput, respondBidirectional.outputLen),
      JubjubSchnorrSignature {
        announcement: respondBidirectional.announcement,
        response: respondBidirectional.response,
      },
      respondBidirectional.pk
    ),
    "Invalid attestation signature"
  );
  assert(signetRequestsIndex.member(rid), "Request not found");
  signetRequestsIndex.remove(rid);
}
```

Between the two circuits sit the off-chain steps, which this package also covers: poll the central signet contract with `SignetRequestResponseReader` (configured with both contract addresses and the ledger field position of your request index) to collect and verify the MPC's secp256k1 signature (then broadcast the signed transaction to the destination chain), and later the Schnorr-attested execution output to feed back into `verifyResponse`.

The [signet-caller contract](https://github.com/sig-net/midnight-integration/blob/main/packages/caller-contract/src/signet-caller.compact) is the complete, runnable version of this skeleton, exercised end to end by the repository's integration suite; a fuller application (an ERC20 cross-chain vault) lives in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the central signet contract this library reads from.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploy tooling for that contract plus generic Midnight deploy/wallet plumbing.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration); example applications live in [sig-net/midnight-examples](https://github.com/sig-net/midnight-examples).
