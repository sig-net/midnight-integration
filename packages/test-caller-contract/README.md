# Test Caller Contract

A minimal caller [contract](./src/test-caller-contract.compact) used for integration testing only. It is the smallest client that drives the central signet contract through the full request/response protocol:

- `initialise`: pins the contract's MPC response key once after deploy
- `submitSignatureRequest`: submits a signature request with contract-fixed calldata
- `verifyResponse`: verifies the MPC's ECDSA respond-bidirectional response in-circuit

It is a flat contract (8 ledger fields, within the compiler's 15-fields-per-node limit), so its `signBidirectionalEventMap` at ledger field 4 has the single-element ledger-tree path `[4]`. Its notifications therefore carry `requestsPathDepth = 1` and `requestsPath = [4, 0, 0, 0]`. After `yarn compile:test-caller-contract`, the compiled `src/managed/test-caller-contract/compiler/contract-info.json` records this as the map's `"index": 4` (a bare number means a depth-1 path). The chunked (more than 15 field) layout is pinned by the sibling [`test-caller-contract-20-field`](../test-caller-contract-20-field) fixture.

It is exercised by this repository's integration suite (`yarn test:integration-tests`) and is not an integration example. For real integration examples (such as an ERC20 cross chain vault) see [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Compile it from the repo root with `yarn compile:test-caller-contract` (or `yarn compile:test-caller-contract:zk` for prover keys).
