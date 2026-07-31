# Test Caller Contract (20 field)

A 20-field caller [contract](./src/test-caller-contract-20-field.compact) used for integration testing only. Past 15 ledger fields compactc stores state in a chunk tree, and this contract is the fixture that pins `@sig-net/midnight`'s raw ledger readers against that real compiler output. Simulator tests only: no deploy flow, no notifier cross-call.

## The chunked layout it pins

compactc packs a contract's public ledger fields into a state tree whose array nodes hold at most 15 entries. Twenty fields exceed that, so the compiler splits them into two segments (the 5-field remainder segment first, then a full segment of 15):

- fields 0..4 sit at paths `[0, 0]`..`[0, 4]`
- fields 5..19 sit at paths `[1, 0]`..`[1, 14]`
- `signBidirectionalEventMap` (field 19) sits at `[1, 14]`

The compiled artifacts record these paths, which is where a client contract reads the `requestsPathDepth` and `requestsPath` values it packs into `constructSignBidirectionalEventNotificationV1`. After `yarn compile:test-caller-contract-20-field`:

- `src/managed/compiler/contract-info.json` records `"index": [1, 14]` for `signBidirectionalEventMap`
- the generated `src/managed/contract/index.js` accessor reads the same node: `state.asArray()[1].asArray()[14]`

For this map the notification values are `requestsPathDepth = 2` and `requestsPath = [1, 14, 0, 0]` (the path zero padded to 4 entries).

It is not an integration example. For real integration examples (such as an ERC20 cross chain vault) see [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).

Compile it from the repo root with `yarn compile:test-caller-contract-20-field`.
