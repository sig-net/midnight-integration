# @sig-net/midnight

The client-agnostic [Sig Network](https://sig.network) protocol library for the [Midnight blockchain](https://midnight.network), and the seed of a future signet.js Midnight adapter. It carries everything a Midnight contract or off-chain client needs to speak the signet protocol (the MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional)) without binding to any particular contract.

> ## 🚧 Under Construction 🚧
>
> This Sig Network Midnight integration is still under construction.
> Use at your own risk and expect rapid iteration.

## What is in it

- **Shared Compact modules**: the package ships its `.compact` sources, so contracts import them directly:
  ```compact
  import "@sig-net/midnight/src/Signet";
  ```
- **Compiled pure circuits** (`pureCircuits`): the executable reference implementation of the client-agnostic circuits (the attestation digest, response verification, the deploy-time key pin, the notification packer, the ABI word builders and readers). Off-chain code calls these compiled artefacts instead of re-porting the algorithms, so it always agrees with what the contracts prove.
- **TypeScript twins of the wire structs** and signet request-id computation.
- **State readers, request feed and resolver**: poll the signet contract for pending requests and their signature / remote-execution responses.
- **Crypto helpers**: epsilon derivation and ECDSA attestation verification.

Where signet.js already covers something (for example EVM transaction preparation or address derivation), import it from there. Only what is Midnight-specific lives here.

## Install

```sh
npm install @sig-net/midnight
```

## Sign bidirectional flow

The flow comprises 5 steps:

1. Client calls a contract on Midnight which requests a signature for a transaction destined for a foreign chain. The signature is made with a key derived for the requesting contract (see [Derived keys](#derived-keys)).
2. The Sig Network MPC honours the request, generating the transaction signature and posting it back to Midnight.
3. Client extracts the signature, using it to submit the signed transaction to the foreign chain.
4. The Sig Network MPC observes the foreign transaction and posts the output of the execution (signed) back to Midnight.
5. Client extracts the signed foreign execution output and submits it back to the Midnight contract, which verifies the MPC's signature over it in-circuit against the contract's own response key (see [Derived keys](#derived-keys)), completing the foreign transaction execution.

## Derived keys

Every key the MPC uses is derived for the requesting contract and a path. There are two kinds: the request signing key, whose path each contract chooses, and the response signing key, whose path is fixed by the protocol. Both key derivations are **scoped by the address** of the requesting contract.

### Request signing key

The key the MPC signs requested foreign transactions with:

`requestSigningKey = f(mpcRootKey[keyVersion], contractAddress, path)`

The path is 32 opaque bytes of the contract's choosing (e.g. a fixed literal for a contract-owned account like "vault", or a hash of a caller's secret for per-user accounts). There are no format requirements. The contract address is always part of the derivation, so no contract can reach another contract's derived keys.

### Response key

The key the MPC signs foreign execution outputs with when posting them back to Midnight:

`responseKey = f(mpcRootKey[keyVersion], contractAddress, "midnight response key")`

The same derivation, but with the path fixed to the literal `"midnight response key"`, giving each contract one well-known response key. A contract pins its own response key in its ledger after deploy and verifies every response against it in-circuit (step 5 of the flow above).

## Integrator guide

A signet-compliant client contract does four things: it stores its requests in a public `SignBidirectionalEventMap` in its own ledger, it pins its counterparties (the Signet singleton contract and its own MPC response key), it submits signature requests, and it verifies execution responses in-circuit. Concretely, the integration consists of:

- 3 once-off **setup** steps
- 5 per-request **runtime** steps that drive the full sign bidirectional flow

### Setup

Set up your contract for integration with the Sig Network MPC's sign bidirectional flow:

1. Import the Signet module at the top of your contract (resolved through `node_modules` via `COMPACT_PATH`):

   ```compact
   import "@sig-net/midnight/src/Signet";
   ```

   Then tell the compact compiler about the npm packages with its `COMPACT_PATH` environment variable at compile time:

   ```sh
   COMPACT_PATH=node_modules compact compile --feature-zkir-v3 src/my-contract.compact src/managed/my-contract
   ```

   Compile with the pinned toolchain (currently `compact update 0.33.0-rc.2`) and always pass `--feature-zkir-v3`: compiled output without it is not compatible with the ledger-9 matched stack (node, indexer, proof server).

2. Declare the required Sig Network protocol state in your ledger (plus recommended deployer identity and initialisation state). The event map can sit at ANY ledger field: each notification your contract registers names the field position holding it (runtime step 1), and the MPC reads the authenticated request from there.

   ```compact
   // Required: Map of SignBidirectionalEvent signature requests, configured by transaction type.
   // Configured and sized here for an EVM Type 2 transaction with
   // <1 calldata word, 0 access-list entries, 0 storage keys> and
   // 34-byte serialisation schemas.
   export ledger signBidirectionalEventMap: SignBidirectionalEventMap<EVMType2TxParams<1, 0, 0>, 34, 34>;

   // Required: The Signet singleton signer interface, set at deploy.
   // Used to notify the MPC of events you add to your signBidirectionalEventMap.
   sealed ledger signetSigner: SignetSigner;

   // Required: This contract's MPC response key, set in step 3.
   // Used to verify RespondBidirectionalEvents containing the serialised output of foreign chain execution.
   export ledger mpcResponseKey: Secp256k1Point;

   // Recommended: contract-local source of request nonces, so identical
   // requests hash to distinct request ids. Nothing off-chain reads it.
   export ledger signetRequestNonce: Counter;

   // Recommended: used in step 3 to ensure initialisation runs only once.
   export ledger initialised: Counter;

   // Recommended: set on deploy, used in step 3 to ensure only the deployer may set the mpcResponseKey.
   sealed ledger deployer: Bytes<32>;

   // Recommended: supplies the deployer's identity secret from private state
   // off-chain; only its commitment (below) ever reaches the ledger.
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

### Runtime

Each interaction with your contract that executes a transaction on a foreign chain runs these 5 steps.

Steps 1 and 5 are circuits on your contract, and steps 2 to 4 are off-chain client code built on the utilities in `@sig-net/midnight`.

The off-chain steps share one `SignetRequestResponseReader` over your contract / Signet singleton pair, and the expected signer of the requested transaction (the key the MPC derives for your contract and the request's path, see [Derived keys](#derived-keys)):

```ts
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { deriveEvmAddress, SignetRequestResponseReader } from "@sig-net/midnight";

// SignetRequestResponseReader to poll for Signed Transactions and Signed RespondBidirectionalEvents
const reader = new SignetRequestResponseReader({
   // Address of YOUR deployed contract
   requesterContractAddress: myContractAddress,

   // signBidirectionalEventMap's field position (Setup step 2)
   requesterRequestsIndexField: 0,

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

1. Store a signature request and notify the MPC via cross contract call. Build (or overwrite) every part of the transaction your contract enforces in-circuit, calldata above all (see [EVM Type 2 transactions and ABI calldata words](#evm-type-2-transactions-and-abi-calldata-words)); never pass caller input through unchecked:

   ```compact
   // Construct SignBidirectionalEvent signature request and calculate its RequestId
   const request = constructSignBidirectionalEvent<EVMType2TxParams<1, 0, 0>, 34, 34>(/* ... */);
   const requestId = disclose(calculateRequestId<EVMType2TxParams<1, 0, 0>, 34, 34>(request));

   // Store the signature request in your signBidirectionalEventMap for MPC to discover
   signetRequestNonce.increment(1);
   signBidirectionalEventMap.insert(requestId, disclose(request));

   // Notify the MPC of the SignBidirectionalEvent and the location of your signBidirectionalEventMap.
   // The location is 0 here based on the position of the declaration in Setup step 2.
   signetSigner.signBidirectionalEvent(
      requestId,
      constructSignBidirectionalEventNotificationV1(kernel.self(), 0 as Uint<8>),
   );
   ```

   **NOTE:** `requestId` should be returned from the above circuit call so that it may be used in subsequent steps (or compute it off-chain with the `calculateRequestId` TS twin).

2. Poll the Signet singleton for the MPC's signature response. The response log is unauthenticated (anyone can post), so use the verifying getter: it only returns a post whose signature recovers to `expectedSigner` over the requested transaction's signing hash:

   ```ts
   const { verified } = await reader.getVerifiedSignatureRespondedEvent(requestId, expectedSigner);
   // verified === undefined: no valid response posted yet, poll again.
   ```

3. Construct the signed transaction and submit it to the foreign chain. The reader rebuilds the transaction from the request record on your ledger and attaches the verified MPC signature:

   ```ts
   import { JsonRpcProvider } from "ethers";

   const signedTx = await reader.getSignedEVMTransaction(requestId, expectedSigner);
   await new JsonRpcProvider(foreignChainRpcUrl).broadcastTransaction(signedTx.serialized);
   ```

4. Poll the Signet singleton for the MPC's signed remote execution output (posted once the MPC observes the transaction execute on the foreign chain). Posts are stored unverified, so treat them as candidates: the authoritative check is your contract's verify circuit in step 5:

   ```ts
   const [respondBidirectionalEvent] = await reader.getRespondBidirectionalEvents(requestId);
   // Empty array: not posted yet, poll again.
   ```

5. Deliver the response to your contract, which verifies it in-circuit against the response key pinned in Setup step 3 and consumes the request:

   ```compact
   assert(
      verifyRespondBidirectionalEvent(requestId, respondBidirectionalEvent, mpcResponseKey),
      "Invalid attestation signature"
   );
   signBidirectionalEventMap.remove(requestId);
   ```

## EVM Type 2 transactions and ABI calldata words

An `EVMType2TxParams` request decomposes the EVM transaction into typed fields your contract can enforce field by field in-circuit. Its optional `calldata` is an `EVMCalldata<maxWords>`: the 4-byte function selector plus a list of 32-byte ABI words, per the [Solidity ABI spec](https://docs.soliditylang.org/en/latest/abi-spec.html). Slots past `noWords` are unused capacity and never reach the transaction.

Every word must be stored in canonical ABI form (big-endian). The MPC signs a transaction whose calldata is exactly `selector || words[0..noWords]`, byte for byte, so a word stored in any other form becomes a signed transaction calling the foreign contract with garbage arguments. Compact's integer casts are little-endian, so do not hand-roll the byte order: build every word with the module's helper circuits, and read words back with the matching readers.

| Solidity type | Build with | Read back with |
|---|---|---|
| `address` | `evmAddressAbiWord(addr: Bytes<20>)` | |
| unsigned integers up to `uint128` (amounts, ids) | `numericAbiWord(value: Uint<128>)` | `abiWordToUint128(word)` |
| `bool` | `boolAbiWord(value: Boolean)` | `abiWordToBool(word)` |

### Example: an ERC20 transfer

`transfer(address,uint256)`, selector `0xa9059cbb`, takes an address word and a numeric word:

```compact
const calldata = EVMCalldata<2> {
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
const calldata = EVMCalldata<2> {
  selector: Bytes[0xa2, 0x2c, 0xb4, 0x65],
  noWords: 2 as Uint<16>,
  words: [
    evmAddressAbiWord(operator),
    boolAbiWord(true)
  ]
};
```

The readers run the same rules in the other direction, rejecting any non-canonical word instead of silently truncating or coercing it. A `RespondBidirectionalEvent`'s `serializedOutput` is the ABI-encoded return data of the remote call, so a settle circuit can decode an ERC20 `transfer`'s `bool` return from the first output word:

```compact
const success = abiWordToBool(slice<32>(respondBidirectionalEvent.serializedOutput, 0));
assert(success, "Remote transfer failed");
```

The same builders and readers exist as TypeScript twins under identical names, for composing expected words off-chain (UIs, expected-record builders, tests). They are kept in lockstep with the compiled circuits by this package's test suite.

## More examples

For full integration examples (such as an ERC20 cross chain vault) see the [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples) repository.

## Related packages

- [`@sig-net/midnight-contract`](https://www.npmjs.com/package/@sig-net/midnight-contract): the central signet contract this library reads from.
- [`@sig-net/midnight-contract-deploy`](https://www.npmjs.com/package/@sig-net/midnight-contract-deploy): deploy tooling for that contract plus generic Midnight deploy/wallet plumbing.

Developed in [sig-net/midnight-integration](https://github.com/sig-net/midnight-integration).
