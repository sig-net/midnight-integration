// Contract-deploy plumbing shared by every contract package's deploy script
// (ported from midday app/ui/lib/actions/buildDeployTransaction.ts): the
// deploy config, the compiled-contract binding, and building the unproven
// deploy transaction. Everything contract-SPECIFIC — constructor args, witness
// implementations, initial private state — stays in the contract package's own
// deploy.ts and arrives here through the type parameters.

import { NodeContext } from "@effect/platform-node";
import { CompiledContract, Contract, ContractExecutable } from "@midnight-ntwrk/compact-js/effect";
import { ZKFileConfiguration } from "@midnight-ntwrk/compact-js-node/effect";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import * as Configuration from "@midnight-ntwrk/platform-js/effect/Configuration";
import * as CoinPublicKey from "@midnight-ntwrk/platform-js/effect/CoinPublicKey";
import type { FacadeState } from "@midnight-ntwrk/wallet-sdk-facade";
import { Effect, Layer, Option, type Types } from "effect";

import { getMidnightNodeConfig, type MidnightNodeConfig } from "./midnight-node-config.ts";
import type { NetworkId } from "./network-id.ts";

/** Everything needed to perform a contract deploy: which stack to target, and which wallet pays for it. */
export interface DeployConfig {
  /** The stack (node/indexer/proof-server endpoints + network id) to deploy to. */
  readonly midnightNodeConfig: MidnightNodeConfig;
  /** Seed (hex or mnemonic) of the wallet that funds & signs the deploy. */
  readonly deployerSeed: string;
}

// Pre-funded genesis wallet of the local standalone stack — the default
// deployer for development.
const GENESIS_MINT_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

/**
 * Read a {@link DeployConfig} from the environment. Every variable is
 * optional: node config per {@link getMidnightNodeConfig}, plus
 * `DEPLOYER_SEED` (hex or mnemonic) defaulting to the genesis mint wallet.
 *
 * @param env - The environment to read from; defaults to `process.env`.
 * @returns The resolved deploy configuration.
 */
export function getDeployConfig(env: Record<string, string | undefined> = process.env): DeployConfig {
  return {
    midnightNodeConfig: getMidnightNodeConfig(env),
    deployerSeed: env.DEPLOYER_SEED?.trim() || GENESIS_MINT_WALLET_SEED,
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
