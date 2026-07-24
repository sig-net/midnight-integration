// Local-EVM (anvil dev chain) plumbing for the real-EVM signet-caller e2e:
// generic contract deployment from a compiled artifact, derived-sender ETH
// funding, nonce reads, and idempotent broadcast of an MPC-signed
// transaction. Everything here signs with the universally-known dev funder
// account, which only exists pre-funded on a throwaway local chain, so every
// entry point is gated on chain id 31337.
//
// Adapted from the midnight-examples test harness (local-evm.ts and the
// erc20-vault broadcast flow), trimmed to what this suite needs.

import {
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  parseEther,
  type InterfaceAbi,
  type Transaction,
  type TransactionReceipt,
} from "ethers";

/** The local dev chain id (the hardhat/anvil convention). */
export const LOCAL_DEV_CHAIN_ID = 31337n;

// Dev account #0 of the universal hardhat/anvil test mnemonic ("test test …
// junk"): pre-funded with 10 000 ETH on every fresh local node, never funded
// on any real network. Deployer of the test target and source of top-ups.
const LOCAL_FUNDER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** ETH top-up target for the derived sender, in wei. */
export const LOCAL_ETH_TARGET = parseEther("10");

/**
 * The tests' host-side EVM endpoint: `EVM_RPC_URL`, defaulting to the `evm`
 * docker compose service's host mapping.
 *
 * @param env - The suite's env accumulator.
 * @returns The JSON-RPC URL.
 */
export function evmRpcUrl(env: NodeJS.ProcessEnv): string {
  return env.EVM_RPC_URL ?? "http://127.0.0.1:8545";
}

/**
 * Assert `rpcUrl` is the local dev chain (id 31337) — the gate on every
 * dev-funder-signed action in this module.
 *
 * @param rpcUrl - The JSON-RPC endpoint to probe.
 * @throws If the endpoint is unreachable or reports another chain id.
 */
export async function assertLocalDevChain(rpcUrl: string): Promise<void> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const { chainId } = await provider.getNetwork();
    if (chainId !== LOCAL_DEV_CHAIN_ID) {
      throw new Error(
        `EVM endpoint ${rpcUrl} reports chain id ${chainId} — the e2e's dev-funder ` +
          `actions (deploy, funding) only run against the local anvil (${LOCAL_DEV_CHAIN_ID})`,
      );
    }
  } finally {
    provider.destroy();
  }
}

/**
 * The compiled-contract fields {@link deployEvmContract} needs from a
 * Solidity compiler artifact (hardhat's hh3-artifact-1 shape carries both).
 */
export interface EvmContractArtifact {
  /** The contract's ABI. */
  abi: InterfaceAbi;
  /** The deployment bytecode as 0x-hex. */
  bytecode: string;
}

/**
 * Deploy a compiled EVM contract to the local dev chain from the dev funder
 * account.
 *
 * @param rpcUrl - JSON-RPC endpoint of the LOCAL dev chain.
 * @param artifact - The compiled contract to deploy.
 * @returns The deployed contract's address.
 */
export async function deployEvmContract(
  rpcUrl: string,
  artifact: EvmContractArtifact,
): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const funder = new Wallet(LOCAL_FUNDER_PRIVATE_KEY, provider);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, funder);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    return await contract.getAddress();
  } finally {
    provider.destroy();
  }
}

/**
 * Whether an address holds contract code — the "kept address survived an
 * anvil restart" check.
 *
 * @param rpcUrl - The JSON-RPC endpoint.
 * @param address - The address to probe.
 * @returns `true` when code is present.
 */
export async function hasContractCode(rpcUrl: string, address: string): Promise<boolean> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return (await provider.getCode(address)) !== "0x";
  } finally {
    provider.destroy();
  }
}

/**
 * Idempotent ETH top-up of one account on the local dev chain: bring it to at
 * least {@link LOCAL_ETH_TARGET} wei, sent from the dev funder. No-ops when
 * the balance already meets the target, so reruns skip naturally.
 *
 * @param rpcUrl - JSON-RPC endpoint of the LOCAL dev chain.
 * @param address - The account to top up.
 * @returns The account's ETH balance after the top-up.
 */
export async function topUpEth(rpcUrl: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    // NonceManager: the provider coalesces identical RPC calls for ~250ms,
    // and with instant automine a second tx's nonce lookup can hit that
    // cache and reuse the first tx's nonce — track the nonce locally instead.
    const funder = new NonceManager(new Wallet(LOCAL_FUNDER_PRIVATE_KEY, provider));
    const ethBalance = await provider.getBalance(address);
    if (ethBalance < LOCAL_ETH_TARGET) {
      const sendTx = await funder.sendTransaction({
        to: address,
        value: LOCAL_ETH_TARGET - ethBalance,
      });
      await sendTx.wait();
    }
    // Computed, not re-read: an immediate re-read through this provider can
    // return the pre-top-up value from its short-lived RPC cache.
    return ethBalance < LOCAL_ETH_TARGET ? LOCAL_ETH_TARGET : ethBalance;
  } finally {
    provider.destroy();
  }
}

/**
 * The chain nonce a fresh request must carry for `address` — the MPC signs
 * exactly the nonce the request declares, so it must be current at submit
 * time.
 *
 * @param rpcUrl - The JSON-RPC endpoint.
 * @param address - The sending account.
 * @returns The account's next nonce.
 */
export async function getEvmNonce(rpcUrl: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    return BigInt(await provider.getTransactionCount(address, "latest"));
  } finally {
    provider.destroy();
  }
}

/**
 * The "this exact tx was already submitted" family of node errors. Re-POSTing
 * a signed tx the node has already seen is a no-op on-chain (same
 * nonce+signature means the same hash, one transaction), so these are safe to
 * swallow and fall through to waiting on the hash.
 */
function isAlreadySubmitted(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "NONCE_EXPIRED") return true;
  const message = ((err as { message?: string })?.message ?? "").toLowerCase();
  return (
    message.includes("already known") ||
    message.includes("already imported") ||
    message.includes("alreadyknown") ||
    message.includes("nonce too low")
  );
}

/**
 * Broadcast an MPC-signed EVM transaction and wait for one confirmation,
 * returning the RECEIPT (the recompute stage needs its block number).
 * Idempotent: a signed tx is content-addressed, so it can only mine once —
 * an existing receipt short-circuits, an already-submitted error is
 * swallowed, and a burned nonce (a different tx took the slot) errors rather
 * than hanging.
 *
 * @param rpcUrl - The JSON-RPC endpoint.
 * @param transaction - The signed transaction (e.g. from
 *   `signBidirectionalEventToSignedEVMTransaction`).
 * @returns The mined receipt (status 1).
 * @throws Error when the transaction reverted on-chain (status 0), or its
 *   nonce was consumed by a different transaction.
 */
export async function broadcastSignedTx(
  rpcUrl: string,
  transaction: Transaction,
): Promise<TransactionReceipt> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const { hash, from, nonce } = transaction;
    if (hash === null || from === null) {
      throw new Error("transaction is missing a signature (cannot derive hash/sender)");
    }

    const mined = await provider.getTransactionReceipt(hash);
    if (mined !== null) {
      console.log(`already mined at block ${mined.blockNumber}`);
      return assertMinedOk(mined, hash);
    }

    try {
      await provider.broadcastTransaction(transaction.serialized);
      console.log(`broadcast: ${hash} (nonce ${nonce}) — waiting for 1 confirmation…`);
    } catch (err) {
      if (!isAlreadySubmitted(err)) throw err;
      console.log(`already submitted — waiting for 1 confirmation…`);
    }

    for (;;) {
      let receipt: TransactionReceipt | null;
      try {
        receipt = await provider.waitForTransaction(hash, 1, 15_000);
      } catch (err) {
        // ethers v6 REJECTS with TIMEOUT at the window edge (it does not
        // resolve null) — treat as "not yet" and re-check the nonce below.
        if ((err as { code?: string })?.code !== "TIMEOUT") throw err;
        receipt = null;
      }
      if (receipt !== null) {
        return assertMinedOk(receipt, hash);
      }
      const latestNonce = await provider.getTransactionCount(from, "latest");
      if (latestNonce > nonce) {
        // The nonce advanced: either OUR tx just mined (waitForTransaction
        // can miss an inclusion at its window edge) or another tx took the
        // slot. Only the receipt distinguishes the two.
        const latestReceipt = await provider.getTransactionReceipt(hash);
        if (latestReceipt !== null) {
          return assertMinedOk(latestReceipt, hash);
        }
        throw new Error(
          `nonce ${nonce} for ${from} was consumed by a different transaction; ` +
            `this signed tx (${hash}) can never mine`,
        );
      }
      console.log(`still pending (account nonce ${latestNonce}) — waiting…`);
    }
  } finally {
    provider.destroy();
  }
}

/**
 * A mined receipt with `status: 0` means the tx was included but reverted
 * (nonce consumed, gas burned, state rolled back) — a failure, not a result.
 */
function assertMinedOk(receipt: TransactionReceipt, hash: string): TransactionReceipt {
  if (receipt.status === 0) {
    throw new Error(
      `transaction ${hash} reverted on-chain (mined in block ${receipt.blockNumber}, status 0)`,
    );
  }
  return receipt;
}
