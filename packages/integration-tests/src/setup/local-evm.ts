// Local-EVM (hardhat/anvil dev chain) setup plumbing: TestUSDC deployment and
// derived-account funding. Setup-only — the read helpers the flow tests share
// live in ../evm.ts. Everything here signs with the universally-known dev
// funder account, which only exists pre-funded on a throwaway local chain.

import { readFileSync } from "node:fs";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther, parseUnits } from "ethers";
import type { InterfaceAbi } from "ethers";

/** EVM chain ids the setup pipeline keys behavior on. */
export enum WellKnownEvmChainId {
  /** Sepolia testnet — the remote default; derived accounts are funded manually. */
  Sepolia = 11155111,
  /**
   * Local dev chain (the hardhat/anvil convention) — setup auto-deploys the
   * ERC20 when absent and auto-funds the derived accounts.
   */
  LocalDev = 31337,
}

/**
 * Whether `chainId` is the local dev chain ({@link WellKnownEvmChainId.LocalDev}),
 * i.e. whether setup may deploy the test ERC20 and fund accounts from the dev
 * funder account.
 *
 * @param chainId - The chain id reported by the RPC endpoint.
 * @returns `true` for the local dev chain, `false` for any real network.
 */
export function isLocalEvmChain(chainId: bigint): boolean {
  return chainId === BigInt(WellKnownEvmChainId.LocalDev);
}

// Dev account #0 of the universal hardhat/anvil test mnemonic ("test test …
// junk"): pre-funded with 10 000 ETH on every fresh local node, never funded
// on any real network. Deployer of TestUSDC and source of all top-ups.
const LOCAL_FUNDER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** ETH top-up target per derived account on the local chain, in wei. */
export const LOCAL_ETH_TARGET = parseEther("10");

/** TestUSDC top-up target per derived account, in 6-decimal token units (1000 USDC). */
export const LOCAL_TOKEN_TARGET = parseUnits("1000", 6);

// The hh3-artifact-1 fields deployTestUsdc needs from hardhat's compiler
// output (artifacts/contracts/TestUSDC.sol/TestUSDC.json).
interface TestUsdcArtifact {
  abi: InterfaceAbi;
  bytecode: string;
}

const TEST_USDC_ARTIFACT_URL = new URL(
  "../../artifacts/contracts/TestUSDC.sol/TestUSDC.json",
  import.meta.url,
);

/**
 * Deploy {@link file://../../contracts/TestUSDC.sol TestUSDC} to the local dev
 * chain from the dev funder account, reading the hardhat compiler artifact.
 *
 * @param rpcUrl - JSON-RPC endpoint of the LOCAL dev chain (`EVM_RPC_URL`).
 * @returns The deployed token's address.
 * @throws If the artifact is missing (run `npm run compile:integration-tests:evm`
 *   at the repo root first) or the deployment fails.
 */
export async function deployTestUsdc(rpcUrl: string): Promise<string> {
  let artifactJson: string;
  try {
    artifactJson = readFileSync(TEST_USDC_ARTIFACT_URL, "utf8");
  } catch (error) {
    throw new Error(
      `TestUSDC artifact not found at ${TEST_USDC_ARTIFACT_URL.pathname} — run` +
        ` \`npm run compile:integration-tests:evm\` at the repo root first`,
      { cause: error },
    );
  }
  const artifact = JSON.parse(artifactJson) as TestUsdcArtifact;
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const funder = new Wallet(LOCAL_FUNDER_PRIVATE_KEY, provider);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, funder);
    const token = await factory.deploy();
    await token.waitForDeployment();
    return await token.getAddress();
  } finally {
    provider.destroy();
  }
}

const MINTABLE_ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
];

/**
 * Idempotent top-up of one derived account on the local dev chain: bring it to
 * at least {@link LOCAL_ETH_TARGET} wei (sent from the dev funder) and
 * {@link LOCAL_TOKEN_TARGET} token units (via the token's open `mint`). Each
 * asset no-ops when the balance already meets its target, so reruns skip
 * naturally without a separate skip signal.
 *
 * @param rpcUrl - JSON-RPC endpoint of the LOCAL dev chain (`EVM_RPC_URL`).
 * @param erc20Address - The TestUSDC-style token (must expose an open `mint`).
 * @param address - The account to top up.
 * @returns The account's ETH and token balances after the top-up.
 */
export async function topUpLocalAccount(
  rpcUrl: string,
  erc20Address: string,
  address: string,
): Promise<{ ethBalance: bigint; tokenBalance: bigint }> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    // NonceManager: the provider coalesces identical RPC calls for ~250ms,
    // and with instant automine a second tx's nonce lookup can hit that
    // cache and reuse the first tx's nonce — track the nonce locally instead.
    const funder = new NonceManager(new Wallet(LOCAL_FUNDER_PRIVATE_KEY, provider));
    const ethBalance = await provider.getBalance(address);
    if (ethBalance < LOCAL_ETH_TARGET) {
      const sendTx = await funder.sendTransaction({ to: address, value: LOCAL_ETH_TARGET - ethBalance });
      await sendTx.wait();
    }
    const token = new Contract(erc20Address, MINTABLE_ERC20_ABI, funder);
    const tokenBalance = (await token.balanceOf(address)) as bigint;
    if (tokenBalance < LOCAL_TOKEN_TARGET) {
      const mintTx = await token.mint(address, LOCAL_TOKEN_TARGET - tokenBalance);
      await mintTx.wait();
    }
    // Computed, not re-read: an immediate re-read through this provider can
    // return the pre-top-up value from its short-lived RPC cache. We sent
    // exactly the shortfall, so below-target balances land exactly on target.
    return {
      ethBalance: ethBalance < LOCAL_ETH_TARGET ? LOCAL_ETH_TARGET : ethBalance,
      tokenBalance: tokenBalance < LOCAL_TOKEN_TARGET ? LOCAL_TOKEN_TARGET : tokenBalance,
    };
  } finally {
    provider.destroy();
  }
}
