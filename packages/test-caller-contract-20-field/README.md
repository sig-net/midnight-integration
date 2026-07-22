# Test Caller Contract (20 field)

A 20-field caller [contract](./src/test-caller-contract-20-field.compact) used for integration testing only. Past 15 ledger fields compactc stores state in a chunk tree, and this contract is the fixture that pins `@sig-net/midnight`'s raw ledger readers against that real compiler output. Simulator tests only: no deploy flow, no notifier cross-call.

It is not an integration example. For real integration examples (such as an ERC20 cross chain vault) see [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Compile it from the repo root with `yarn compile:test-caller-contract-20-field`.
