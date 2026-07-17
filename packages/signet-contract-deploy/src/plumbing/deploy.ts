// Contract-deploy plumbing shared by every contract package's deploy script
// (ported from midday app/ui/lib/actions/buildDeployTransaction.ts): the
// deploy config, the compiled-contract binding, and building the unproven
// deploy transaction. Everything contract-SPECIFIC — constructor args, witness
// implementations, initial private state — stays in the contract package's own
// deploy.ts and arrives here through the type parameters.

import { NodeContext } from "@effect/platform-node";
import { CompiledContract, Contract, ContractExecutable } from "@midnight-ntwrk/compact-js/effect";
import { ZKFileConfiguration } from "@midnight-ntwrk/compact-js-node/effect";
import * as ledger from "@midnightntwrk/ledger-v9";
import * as Configuration from "@midnight-ntwrk/platform-js/effect/Configuration";
import * as CoinPublicKey from "@midnight-ntwrk/platform-js/effect/CoinPublicKey";
import type { FacadeState } from "@midnightntwrk/wallet-sdk-facade";
import { Effect, Layer, Option, type Types } from "effect";

import { FAUCET_URLS, getMidnightNodeConfig, type MidnightNodeConfig } from "./midnight-node-config.ts";
import { isLocalStandaloneNetwork, type NetworkId } from "./network-id.ts";

/** Everything needed to perform a contract deploy: which stack to target, and which wallet pays for it. */
export interface DeployConfig {
  /** The stack (node/indexer/proof-server endpoints + network id) to deploy to. */
  readonly midnightNodeConfig: MidnightNodeConfig;
  /** Seed (hex or mnemonic) of the wallet that funds & signs the deploy. */
  readonly deployerSeed: string;
}

// Pre-funded genesis wallet of the local standalone stack — the default
// deployer for development, and the ONLY network where it holds funds.
export const GENESIS_MINT_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

// True when `seed` is the genesis mint seed in hex form (0x-optional,
// case-insensitive). A mnemonic never matches. Used to reject the genesis
// seed on a deployed network, where it is unfunded.
function isGenesisSeed(seed: string): boolean {
  return seed.trim().replace(/^0x/i, "").toLowerCase() === GENESIS_MINT_WALLET_SEED;
}

/**
 * Resolve the deployer seed for `networkId`. On the local standalone chain
 * the genesis mint wallet is the default; on every deployed network the
 * genesis wallet is unfunded, so a `DEPLOYER_SEED` funded via that network's
 * faucet is required. The single consumer is {@link getDeployConfig}.
 *
 * @param env - The environment to read `DEPLOYER_SEED` from.
 * @param networkId - The network the deploy targets.
 * @returns The seed (hex or mnemonic) that funds & signs deploys.
 * @throws If a deployed network has no `DEPLOYER_SEED`, or it is set to the
 *   (unfunded-here) genesis mint seed.
 */
function resolveDeployerSeed(env: Record<string, string | undefined>, networkId: NetworkId): string {
  const provided = env.DEPLOYER_SEED?.trim();
  if (isLocalStandaloneNetwork(networkId)) {
    return provided || GENESIS_MINT_WALLET_SEED;
  }
  const faucet = FAUCET_URLS[networkId];
  const fundHint = faucet ? `fund a wallet via ${faucet}` : "fund a wallet via the network's faucet";
  if (!provided) {
    throw new Error(
      `DEPLOYER_SEED is required on "${networkId}": the genesis mint seed only holds funds on the local ` +
        `standalone chain. Set DEPLOYER_SEED (hex or mnemonic) to a funded wallet: ${fundHint}.`,
    );
  }
  if (isGenesisSeed(provided)) {
    throw new Error(
      `DEPLOYER_SEED is the local genesis mint seed, which holds no funds on "${networkId}". ` +
        `${fundHint} and set DEPLOYER_SEED to it.`,
    );
  }
  return provided;
}

/**
 * Read a {@link DeployConfig} from the environment. Node config comes from
 * {@link getMidnightNodeConfig}; the deployer seed from {@link resolveDeployerSeed}
 * (genesis mint wallet on the local chain, a required funded `DEPLOYER_SEED`
 * on every deployed network).
 *
 * @param env - The environment to read from; defaults to `process.env`.
 * @returns The resolved deploy configuration.
 * @throws If a deployed network lacks a valid funded `DEPLOYER_SEED` (see
 *   {@link resolveDeployerSeed}).
 */
export function getDeployConfig(env: Record<string, string | undefined> = process.env): DeployConfig {
  const midnightNodeConfig = getMidnightNodeConfig(env);
  return {
    midnightNodeConfig,
    deployerSeed: resolveDeployerSeed(env, midnightNodeConfig.networkId),
  };
}

/** An unproven contract-deploy transaction, ready to balance/sign/prove/submit via a wallet. */
export interface DeployTransaction {
  /** The contract address this deployment will create, known before submission. */
  readonly contractAddress: string;
  /** The serialized unproven transaction — see `submitUnprovenTransaction` in wallet.ts. */
  readonly serializedTransaction: Uint8Array;
}

/**
 * Bind a generated Compact contract to its witnesses and compiled assets.
 *
 * Thin typed wrapper over the compact-js `CompiledContract` combinators so
 * contract packages need no direct compact-js dependency. Chained data-first
 * on purpose: the witness/asset combinators rebuild the binding via object
 * spread, which drops the prototype carrying `.pipe`.
 *
 * @param tag - Identifier for the binding (not the on-chain address), e.g. the contract name.
 * @param ctor - The `Contract` class exported by the generated `managed/contract` module.
 * @param witnesses - The contract's real witness implementations (from the package's `witnesses.ts`).
 * @param managedDirPath - Absolute path to the compiler output dir (`contract/`, `zkir/`, `keys/`, `compiler/`).
 * @returns The fully-bound {@link CompiledContract.CompiledContract}, ready for {@link buildDeployTransaction}.
 */
export function makeCompiledContract<C extends Contract.Contract<PS>, PS>(
  tag: string,
  ctor: Types.Ctor<C>,
  witnesses: Contract.Contract.Witnesses<C>,
  managedDirPath: string,
): CompiledContract.CompiledContract<C, PS> {
  const base = CompiledContract.make<C, PS>(tag, ctor);
  const withWitnesses = CompiledContract.withWitnesses(base, witnesses);
  return CompiledContract.withCompiledFileAssets(withWitnesses, managedDirPath);
}

/**
 * Bind a generated Compact contract that declares NO witnesses to its
 * compiled assets. Counterpart to {@link makeCompiledContract}: compact-js
 * types `Contract.Witnesses<C>` as `never` when the generated witness shape
 * is empty, so witness-less contracts must bind via `withVacantWitnesses`
 * rather than passing an empty object.
 *
 * @param tag - Identifier for the binding (not the on-chain address), e.g. the contract name.
 * @param ctor - The `Contract` class exported by the generated `managed/contract` module.
 * @param managedDirPath - Absolute path to the compiler output dir (`contract/`, `zkir/`, `keys/`, `compiler/`).
 * @returns The fully-bound {@link CompiledContract.CompiledContract}, ready for {@link buildDeployTransaction}.
 */
export function makeVacantCompiledContract<C extends Contract.Contract<PS>, PS>(
  tag: string,
  ctor: Types.Ctor<C>,
  managedDirPath: string,
): CompiledContract.CompiledContract<C, PS> {
  const base = CompiledContract.make<C, PS>(tag, ctor);
  const vacant = CompiledContract.withVacantWitnesses(base);
  return CompiledContract.withCompiledFileAssets(vacant, managedDirPath);
}

/**
 * Convert a contract address (hex, optional `0x`) into the reference shape a
 * Compact contract-typed constructor arg expects: `{ bytes: Uint8Array(32) }`.
 * Deploy scripts use this to seal a cross-contract reference (e.g. the
 * central signet contract) read from the environment.
 *
 * @param contractAddress - The 32-byte contract address in hex.
 * @returns The `{ bytes }` reference.
 * @throws If the address is not 32 bytes of hex.
 */
export function contractAddressToReference(contractAddress: string): { bytes: Uint8Array } {
  const hex = contractAddress.startsWith("0x") ? contractAddress.slice(2) : contractAddress;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`not a 32-byte contract address in hex: "${contractAddress}"`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return { bytes };
}

// How long the deploy intent stays valid before it must be re-built.
const DEPLOY_TTL_MS = 30 * 60 * 1000;

/**
 * Build an UNPROVEN contract-deploy transaction: run the Compact constructor
 * with `constructorArgs`, attach the verifier keys from the compiled assets,
 * and wrap the resulting contract state in a deploy intent. Touches no
 * network and no wallet — the only wallet-derived input is the deployer's
 * coin public key, which feeds the constructor's context.
 *
 * @param compiledContract - The bound contract, from {@link makeCompiledContract}.
 * @param networkId - The network the transaction targets.
 * @param coinPublicKeyHex - The deploying wallet's Zswap coin public key (hex).
 * @param initialPrivateState - The private state the constructor (and its witnesses, if any) runs against.
 * @param constructorArgs - The contract's constructor arguments, statically typed per contract.
 * @returns The deterministic contract address plus the serialized unproven transaction.
 * @throws If the constructor traps, or the verifier keys are missing from the
 * compiled assets (run `compile:zk` — the default `--skip-zk` output has none).
 */
export async function buildDeployTransaction<C extends Contract.Contract<PS>, PS>(
  compiledContract: CompiledContract.CompiledContract<C, PS>,
  networkId: NetworkId,
  coinPublicKeyHex: string,
  initialPrivateState: PS,
  ...constructorArgs: Contract.Contract.InitializeParameters<C>
): Promise<DeployTransaction> {
  // initialize() needs the deployer's coin public key (for the constructor
  // context) and a signing key for the contract maintenance authority.
  // Option.none() makes the SDK sample a fresh CMA key (discarded — the
  // contract can't be maintained later, which is fine for now).
  const keysLayer = Layer.succeed(Configuration.Keys, {
    coinPublicKey: CoinPublicKey.Hex(coinPublicKeyHex),
    getSigningKey: () => Option.none(),
  });

  // Run the contract constructor and attach verifier keys → initial ContractState.
  const deployResult = await Effect.runPromise(
    ContractExecutable.make(compiledContract)
      .initialize(initialPrivateState, ...constructorArgs)
      .pipe(
        Effect.provide(ZKFileConfiguration.layer(CompiledContract.getCompiledAssetsPath(compiledContract))),
        Effect.provide(NodeContext.layer),
        Effect.provide(keysLayer),
      ),
  );

  // `initialize` yields an onchain-runtime ContractState; bridge it to the
  // ledger's ContractState (separate package/type) via its serialized form.
  const contractState = ledger.ContractState.deserialize(deployResult.public.contractState.serialize());

  const deploy = new ledger.ContractDeploy(contractState);
  const intent = ledger.Intent.new(new Date(Date.now() + DEPLOY_TTL_MS)).addDeploy(deploy);
  const transaction = ledger.Transaction.fromPartsRandomized(networkId, undefined, undefined, intent);

  return {
    contractAddress: deploy.address,
    serializedTransaction: transaction.serialize(),
  };
}

/**
 * Fail fast when the deployer wallet cannot pay for a transaction: fees are
 * paid in DUST, which only generates on NIGHT registered for dust generation.
 *
 * @param state - The synced facade state to inspect (see `withSyncedWalletFacade` in wallet.ts).
 * @throws If the deployer's spendable DUST balance is zero.
 */
export function assertDeployerFunded(state: FacadeState): void {
  const dust = state.dust.balance(new Date());
  if (dust > 0n) return;
  const night = Object.values(state.unshielded.balances).reduce((sum, value) => sum + value, 0n);
  throw new Error(
    `deployer wallet has no DUST to pay fees (NIGHT balance: ${night}). ` +
      "Fund the wallet with NIGHT and register it for dust generation, then retry.",
  );
}
