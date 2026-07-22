# Test Caller Contract

A minimal caller [contract](./src/test-caller-contract.compact) used for integration testing only. It is the smallest client that drives the central signet contract through the full request/response protocol:

- `initialise`: pins the contract's MPC response key once after deploy
- `submitSignatureRequest`: submits a signature request with contract-fixed calldata
- `verifyResponse`: verifies the MPC's ECDSA respond-bidirectional response in-circuit

It is exercised by this repository's integration suite (`yarn test:integration-tests`) and is not an integration example. For real integration examples (such as an ERC20 cross chain vault) see [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Compile it from the repo root with `yarn compile:test-caller-contract` (or `yarn compile:test-caller-contract:zk` for prover keys).
