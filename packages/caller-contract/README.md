# Caller Contract

Caller Contract is a minimal caller contract that exercises the Sig Network MPC's [sign bidirectional flow](https://docs.sig.network/architecture/sign-bidirectional) protocol on Midnight end to end.

The **Sign Bidirectional Flow** comprises of 5 Steps:
1. Client calls a Contract on Midnight which requests a signature for a transaction destined for a foreign chain
2. Sig Network MPC honours the request, generating the transaction signature and posting it back to Midnight
3. Client extracts the signature, using it to submit the signed transaction to the foreign chain
4. Sig Network MPC observes the foreign transaction and posts the output of the execution (signed) back to Midnight
5. Client extracts the signed foreign execution output, then submits it back to the Midnight contract completing the foreign transacttion execution.

This [contract](./src/signet-caller.compact) tests steps 1. and 5. from this flow:
- 1. Requesting Sign Bidrectional on a transaction is tested by exported circuit `submitSignatureRequest`
- 5. Verifying the signed output of the transaction is tested by exported circuit `verifyResponse`

More comprehensive example applications built on this Sig Network 'sign bidrectional flow', such as an ERC20 cross chain vault demo, can be found in [`sig-net/midnight-examples`](https://github.com/sig-net/midnight-examples).