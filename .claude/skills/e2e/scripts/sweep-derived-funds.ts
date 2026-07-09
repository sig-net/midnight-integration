/**
 * Sweep ETH + ERC20 from a fakenet-derived EVM account to another address.
 *
 * After a vault-contract redeploy the epsilon-derived user account moves
 * (the derivation path includes the vault contract address), stranding any
 * Sepolia funds on the OLD derived address. This script recovers them: it
 * re-derives the old account's private key from the fakenet `MPC_ROOT_KEY`
 * (`priv = rootKey + keccak256(epsilonString) mod n` — the private-key twin
 * of signet-midnight's public-key-only `deriveEvmAddress`), verifies the
 * derived address against `--expect`, and transfers the full ERC20 balance
 * plus all ETH minus a gas reserve to `--to`.
 *
 * Fakenet ONLY: it requires the MPC root PRIVATE key, which a real MPC never
 * exposes.
 *
 * Usage (from the repo root, env from .env):
 *   set -a && source .env && set +a
 *   npx tsx .claude/skills/e2e/scripts/sweep-derived-funds.ts \
 *     --old-contract <midnight vault contract address the account derives from> \
 *     --path <derivation path: "vault" or the user commitment hex> \
 *     --expect <the derived address you believe you are sweeping> \
 *     --to <recipient address>
 *
 * Env: MPC_ROOT_KEY, EVM_RPC_URL required; ERC20_ADDRESS optional
 * (defaults to Sepolia USDC).
 */
import {
  Contract,
  formatEther,
  formatUnits,
  JsonRpcProvider,
  keccak256,
  parseUnits,
  toUtf8Bytes,
  Wallet,
} from "ethers";

import {
  EPSILON_DERIVATION_PREFIX,
  MIDNIGHT_TESTNET_CHAIN_ID,
} from "@midnight-erc20-vault/signet-midnight";

/** secp256k1 group order — private keys are reduced modulo this. */
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Default ERC20 to sweep when ERC20_ADDRESS is unset: Sepolia USDC. */
const DEFAULT_ERC20 = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/** Read one `--name value` pair from argv, throwing when absent. */
function requireArg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) {
    throw new Error(`missing required argument --${name}`);
  }
  return value;
}

/** Read a required environment variable, throwing when absent. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

const oldContract = requireArg("old-contract");
const path = requireArg("path");
const expectAddress = requireArg("expect");
const to = requireArg("to");
const erc20Address = process.env.ERC20_ADDRESS ?? DEFAULT_ERC20;

// The private-key side of the sig-net v1.0.0 epsilon scheme:
// epsilon = keccak256("<prefix>,<chainId>,<contract>,<path>") mod n,
// derivedPriv = rootPriv + epsilon mod n.
const epsilonString = `${EPSILON_DERIVATION_PREFIX},${MIDNIGHT_TESTNET_CHAIN_ID},${oldContract},${path}`;
const epsilon = BigInt(keccak256(toUtf8Bytes(epsilonString))) % SECP256K1_ORDER;
const rootKey = BigInt(requireEnv("MPC_ROOT_KEY"));
const derivedPriv = (rootKey + epsilon) % SECP256K1_ORDER;

const provider = new JsonRpcProvider(requireEnv("EVM_RPC_URL"));
const wallet = new Wallet(`0x${derivedPriv.toString(16).padStart(64, "0")}`, provider);

if (wallet.address.toLowerCase() !== expectAddress.toLowerCase()) {
  console.error(
    `derived ${wallet.address} but --expect says ${expectAddress} — refusing to sign anything.\n` +
      `Check --old-contract and --path (path is "vault" or the user commitment hex).`,
  );
  process.exit(1);
}
console.log(`derived key controls ${wallet.address} ✓`);

const erc20 = new Contract(
  erc20Address,
  [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function decimals() view returns (uint8)",
  ],
  wallet,
);

const tokenBalance: bigint = await erc20.balanceOf(wallet.address);
const decimals: bigint = await erc20.decimals();
console.log(`ERC20 ${erc20Address} balance: ${formatUnits(tokenBalance, decimals)}`);
if (tokenBalance > 0n) {
  const tx = await erc20.transfer(to, tokenBalance);
  console.log(`ERC20 transfer tx: ${tx.hash}`);
  await tx.wait();
  console.log("ERC20 transfer confirmed");
}

const ethBalance = await provider.getBalance(wallet.address);
console.log(`ETH balance: ${formatEther(ethBalance)}`);
const feeData = await provider.getFeeData();
const maxFeePerGas = feeData.maxFeePerGas ?? parseUnits("5", "gwei");
// Keep 2x one plain transfer's worst-case fee so this sweep itself can land.
const gasReserve = 21000n * maxFeePerGas * 2n;
if (ethBalance > gasReserve) {
  const tx = await wallet.sendTransaction({
    to,
    value: ethBalance - gasReserve,
    gasLimit: 21000n,
    maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? parseUnits("1", "gwei"),
  });
  console.log(`ETH transfer tx: ${tx.hash} (${formatEther(ethBalance - gasReserve)} ETH)`);
  await tx.wait();
  console.log("ETH transfer confirmed");
} else {
  console.log("ETH balance does not exceed the gas reserve — nothing to sweep");
}
