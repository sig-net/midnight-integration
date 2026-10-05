# Test Caller Contract

A minimal caller [contract](./src/test-caller-contract.compact) used for integration testing only. It is the smallest client that drives the central signet contract through the full request/response protocol:

- `initialise`: pins the contract's MPC response key once after deploy
- `submitSignatureRequest`: submits a signature request with contract-fixed calldata (signed, never broadcast)
- `submitIsEvenRequest`, `submitCheckAndDoubleRequest`, `submitRevertIfRequest`: submit requests against the `SignetEvmTarget` Solidity contract the integration suite broadcasts, one circuit per target method
- `verifyResponse`, `verifyCheckAndDoubleResponse`: verify the MPC's ECDSA respond-bidirectional attestation of an executed call in-circuit, one circuit per attested output width (1 and 33 bytes), deserialise the attested output and consume the request. `verifyCheckAndDoubleResponse` narrows the attested `uint256` to `Uint<128>` with `checkedTruncationU128` and records it in `checkAndDoubleAmounts`.
- `verifyFailureResponse`: settles a `failed` (reverted) or `unviable` (nonce taken) attestation at width 0, consumes the request from whichever map holds it and records the verdict in `failureVerdicts`

It is a flat contract (9 ledger fields, within the compiler's 15-fields-per-node limit), so its `signBidirectionalEventMap` at ledger field 3 has the single-element ledger-tree path `[3]`, and the 69-byte-schema map `signBidirectionalEventMap69` at field 6 the path `[6]`. Its notifications therefore carry `requestsPathDepth = 1` and `requestsPath = [3, 0, 0, 0]` or `[6, 0, 0, 0]`. After `yarn compile:test-caller-contract`, the compiled `src/managed/test-caller-contract/compiler/contract-info.json` records these as the maps' `"index": 3` and `"index": 6` (a bare number means a depth-1 path). The chunked (more than 15 field) layout is pinned by the sibling [`test-caller-contract-20-field`](../test-caller-contract-20-field) fixture.

It is exercised by this repository's integration suite (`yarn test:integration-tests`) and is not an integration example. For real integration examples (such as an ERC20 cross chain vault) see [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Compile it from the repo root with `yarn compile:test-caller-contract` (or `yarn compile:test-caller-contract:zk` for prover keys).

Each request carries one schema, the ABI field array its EVM return data is decoded with: `[{"name":"success","type":"bool"}]` (34 bytes, the field-3 map) or `[{"name":"success","type":"bool"},{"name":"amount","type":"uint256"}]` (69 bytes, the field-6 map). The `respondSerializationSchema` field is reserved and pinned to `Bytes<0>`. The attested bytes derive from the output schema: a `bool` is one Borsh byte and a `uint256` its whole value as 32 little-endian bytes, so the two responses are 1 and 33 bytes. `verifyCheckAndDoubleResponse` is the example of narrowing an attested `uint256` in-circuit: it reads the amount as `Bytes<32>` and converts it with `checkedTruncationU128`, which aborts on any amount at or above 2^128, so the simulator tests drive it at 2^128 - 1 (recorded) and at 2^128 and the `uint256` maximum (refused with a valid signature).
