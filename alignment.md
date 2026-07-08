
# structs to align on
- SignetEVMSignatureResponse <--> RespondSig
- EVMTransactionParams <--> SignBiEvm
- EVMCalldata<n> (funcSig, argCount, args) <--> argCount+funcSig in part 2, args: Vector<4, Bytes<32>> in part 3
- SignetMPCRoutingParams <--> SignBiCore + parts 4/5
- signetEVMSignatureRequestId <--> SHA-256(tail_1‖…‖tail_P) // change to simpler hashing instead of struct

- EVMTransactionParams — verbatim.
- EVMCalldata<n> (instantiated at 4) — after agreeing the argCount/funcSig order.
- SignetEVMSignatureResponse — verbatim (they already have it, modulo the struct name).
- SignetMPCRoutingParams revised: path → commitment: Bytes<32>; decide whether algo rides in bidirectional requests or stays reserved.
- SignetRespondBidirectional + signetAttestationMessage — pending the Schnorr decision above.
- constructSignetEVMSignatureRequest — its surviving invariant is keyVersion >= 1 (their spec independently states the same rule, so this circuit is genuinely shared logic).
- A shared request-id pure circuit implementing the tails-hash scheme, so the vault, signer, and off-chain code use one implementation.