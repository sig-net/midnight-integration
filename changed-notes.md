- using generated pure circuit functions off chain instead of reproducing functionality
```ts
// e.g. packages/vault-contract/tests/contract.test.ts:64
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);

// instead of:
// FIXME: show older approach of manually reconstructing here...
```

- using typed single location extraction of signature requests data instead of extracting bit by bit without any types
```ts
// Now in the midnight indexer:
const contractState = await this.publicDataProvider.queryContractState(contractAddress);
if (!contractState?.data) {
    console.warn(`no state data found for contract '${contractAddress}'`);
    continue;
};
const typedState = readSignetEVMSignatureRequestIndexFromState(contractState.data);

// instead of:
// FIXME: show summary excerpt from old midnight requests of how the state was being manually exported without any types (summary, all is too much)!!
```