// Generic Midnight deployer — see README.md for the midday pattern this ports.
// Deliberately dependency-free until the port: the heavy deps (compact-js,
// compact-js-node, ledger-v8, platform-js, effect) are already declared and
// installed, ready to use.

/** The only things that vary per contract. */
export interface DeployParams {
  /** Absolute path to the contract's compiler output (contract/, zkir/, keys/, compiler/). */
  managedDirPath: string;
  /** Human-readable identifier for the compiled-contract binding. */
  tag: string;
  /** Midnight network id, e.g. "standalone" | "testnet". */
  networkId: string;
  /** Deployer's coin public key (32-byte hex) for the constructor context. */
  coinPublicKeyHex: string;
}

export interface DeployTransaction {
  /** Deterministic contract address, known before submission. */
  contractAddress: string;
  /** Serialized unproven transaction — balance/sign/prove/submit via the wallet. */
  serializedTransaction: Uint8Array;
}

export async function buildDeployTransaction(_params: DeployParams): Promise<DeployTransaction> {
  throw new Error(
    "not implemented — port from midday app/ui/lib/actions/buildDeployTransaction.ts (see README.md)",
  );
}
