- using generated pure circuit functions off chain instead of reproducing functionality
```ts
// e.g. packages/vault-contract/tests/contract.test.ts:64
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);

// instead of:
// FIXME: show older approach of manually reconstructing here...
```

- using typed single location extraction of signature requests data instead of extracting bit by bit without any types
```ts
// e.g. packages/vault-contract/tests/contract.test.ts:168
const rawIndex = readSignetEVMSignatureRequestIndexFromState(rawState);
const typedIndex = toSignetEVMSignatureRequestIndex(
    ledger(ctx.currentQueryContext.state).signetRequestsIndex,
);
expect(rawIndex).toEqual(typedIndex);
expect(rawIndex.size).toBe(0);

// instead of:
// FIXME: show excerpt from old midnight requests of how the state was being manually exported without any types
```