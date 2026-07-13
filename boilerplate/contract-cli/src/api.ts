import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { contracts, witnesses } from '@midnight-ntwrk/contract';
import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { deployContract, findDeployedContract, submitCallTx, createCallTxOptions } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { assertIsContractAddress, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  type MidnightProvider,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { InMemoryTransactionHistoryStorage, TransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { webcrypto } from 'crypto';
import { Buffer } from 'buffer';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import {
  type VaultPrivateState,
  type VaultPrivateStateId,
  type VaultProviders,
  type DeployedVaultContract,
} from './common-types';
import { type Config, contractConfig } from './config';

// Get the dynamic contract module
const getContractModule = () => {
  const contractNames = Object.keys(contracts);
  if (contractNames.length === 0) {
    throw new Error('No contract found in contracts object');
  }
  return contracts[contractNames[0]];
};

const contractModule = getContractModule();

// Re-export the shared, app-neutral Schnorr challenge for the off-chain signer.
export { schnorrChallenge } from '@midnight-ntwrk/contract';

let logger: Logger;

// @ts-expect-error: It's needed to enable WebSocket usage through apollo
globalThis.WebSocket = WebSocket;

// v4 CompiledContract: builder pattern with actual witnesses
// (vault contract requires mpcSecret + callerPublicKey witnesses)
// Dynamic contract module generics resolve to never, so we bypass strict checks.
const _withWitnesses = CompiledContract.withWitnesses as any;
const _withAssets = CompiledContract.withCompiledFileAssets as any;
export const vaultCompiledContract: any = _withAssets(
  _withWitnesses(
    CompiledContract.make('erc20-vault', contractModule.Contract),
    witnesses,
  ),
  contractConfig.zkConfigPath,
);

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

export const getLedgerState = async (
  providers: VaultProviders,
  contractAddress: ContractAddress,
) => {
  assertIsContractAddress(contractAddress);
  logger.info('Checking contract ledger state...');
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState?.data) {
    const ledgerData = contractModule.ledger(contractState.data);
    return ledgerData;
  }
  return null;
};

export const deploy = async (
  providers: VaultProviders,
  privateState: VaultPrivateState,
  mpcPk: { x: bigint; y: bigint },
  deployerCommitment: Uint8Array,
): Promise<DeployedVaultContract> => {
  logger.info('Deploying ERC20 vault contract...');
  const vaultContract = await deployContract(providers, {
    compiledContract: vaultCompiledContract,
    privateStateId: 'vaultPrivateState',
    initialPrivateState: privateState,
    args: [mpcPk, deployerCommitment],
  } as any);
  logger.info(`Deployed contract at address: ${vaultContract.deployTxData.public.contractAddress}`);
  return vaultContract;
};

export const joinContract = async (
  providers: VaultProviders,
  contractAddress: string,
  privateState: VaultPrivateState,
): Promise<DeployedVaultContract> => {
  const vaultContract = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: vaultCompiledContract,
    privateStateId: 'vaultPrivateState',
    initialPrivateState: privateState,
    args: [],
  } as any);
  logger.info(`Joined contract at address: ${vaultContract.deployTxData.public.contractAddress}`);
  return vaultContract;
};

/**
 * Sign all unshielded offers in a transaction's intents, using the correct
 * proof marker for Intent.deserialize. This works around a bug in the wallet
 * SDK where signRecipe hardcodes 'pre-proof', which fails for proven
 * (UnboundTransaction) intents that contain 'proof' data.
 */
const signTransactionIntents = (
  tx: { intents?: Map<number, any> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof',
): void => {
  if (!tx.intents || tx.intents.size === 0) return;

  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;

    const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
      'signature',
      proofMarker,
      'pre-binding',
      intent.serialize(),
    );

    const sigData = cloned.signatureData(segment);
    const signature = signFn(sigData);

    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }

    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }

    tx.intents.set(segment, cloned);
  }
};

/**
 * Create the unified WalletProvider & MidnightProvider for midnight-js.
 * Uses WalletFacade.balanceUnboundTransaction which works directly with
 * ledger-v8 types — no serialization bridge needed.
 */
export const createWalletAndMidnightProvider = async (
  ctx: WalletContext,
): Promise<WalletProvider & MidnightProvider> => {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx, ttl?) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );

      const signFn = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }

      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx(tx) {
      return ctx.wallet.submitTransaction(tx) as any;
    },
  };
};

export const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((state) => state.isSynced),
    ),
  );

export const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.filter((state) => state.isSynced),
      Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );

const buildShieldedConfig = ({ indexer, indexerWS, node, proofServer }: Config) => ({
  networkId: getNetworkId(),
  indexerClientConnection: {
    indexerHttpUrl: indexer,
    indexerWsUrl: indexerWS,
  },
  provingServerUrl: new URL(proofServer),
  relayURL: new URL(node.replace(/^http/, 'ws')),
});

const buildUnshieldedConfig = ({ indexer, indexerWS }: Config) => ({
  networkId: getNetworkId(),
  indexerClientConnection: {
    indexerHttpUrl: indexer,
    indexerWsUrl: indexerWS,
  },
  txHistoryStorage: new InMemoryTransactionHistoryStorage(TransactionHistoryStorage.TransactionHistoryCommonSchema),
});

const buildDustConfig = ({ indexer, indexerWS, node, proofServer }: Config) => ({
  networkId: getNetworkId(),
  costParameters: {
    additionalFeeOverhead: 10_000_000_000_000n,
    feeBlocksMargin: 5,
  },
  indexerClientConnection: {
    indexerHttpUrl: indexer,
    indexerWsUrl: indexerWS,
  },
  provingServerUrl: new URL(proofServer),
  relayURL: new URL(node.replace(/^http/, 'ws')),
});

/**
 * Derive HD wallet keys for all three roles (Zswap, NightExternal, Dust)
 * from a hex-encoded seed.
 */
const deriveKeysFromSeed = (seed: string) => {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet from seed');
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Failed to derive keys');
  }

  hdWallet.hdWallet.clear();
  return derivationResult.keys;
};

// Build + sync a wallet without blocking on funds (for a wallet genesis doesn't endow).
export const buildWallet = async (
  config: Config,
  seed: string,
): Promise<WalletContext> => {
  logger.info('Building wallet from seed...');

  const keys = deriveKeysFromSeed(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const walletConfig = {
    ...buildShieldedConfig(config),
    ...buildUnshieldedConfig(config),
    ...buildDustConfig(config),
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  logger.info(`Your wallet seed is: ${seed}`);
  logger.info(`Unshielded address: ${unshieldedKeystore.getBech32Address()}`);
  await waitForSync(wallet);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};

export const buildWalletAndWaitForFunds = async (
  config: Config,
  seed: string,
): Promise<WalletContext> => {
  const ctx = await buildWallet(config, seed);
  const syncedState = await waitForSync(ctx.wallet);

  const balance = syncedState.unshielded.balances[unshieldedToken().raw] ?? 0n;
  if (balance === 0n) {
    logger.info('Your wallet balance is: 0');
    logger.info('Waiting to receive tokens...');
    const fundedBalance = await waitForFunds(ctx.wallet);
    logger.info(`Your wallet balance is: ${fundedBalance}`);
  } else {
    logger.info(`Your wallet balance is: ${balance}`);
  }

  return ctx;
};

// Fund a fresh wallet's proving fees: transfer NIGHT, then register it for dust generation
// (register → finalizeRecipe → submit — do NOT also signRecipe, or the node rejects with
// "Custom error: 192"). Returns the resulting dust balance.
export const fundWalletForFees = async (
  funder: WalletContext,
  target: WalletContext,
  nightAmount: bigint,
): Promise<bigint> => {
  const NIGHT = unshieldedToken().raw;
  const readDust = (s: any): bigint => {
    const bal = s.dust.balance(new Date());
    return typeof bal === 'bigint' ? bal : BigInt(bal ?? 0);
  };

  // 1. funder → target NIGHT transfer (funder pays the fee from its own dust).
  const tState: any = await Rx.firstValueFrom(target.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const recipe = await funder.wallet.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: NIGHT, receiverAddress: tState.unshielded.address, amount: nightAmount }] }],
    { shieldedSecretKeys: funder.shieldedSecretKeys, dustSecretKey: funder.dustSecretKey },
    { ttl: new Date(Date.now() + 30 * 60 * 1000) },
  );
  const signed = await funder.wallet.signRecipe(recipe, (p) => funder.unshieldedKeystore.signData(p));
  await funder.wallet.submitTransaction(await funder.wallet.finalizeRecipe(signed));
  logger.info(`Funding ${nightAmount} NIGHT → target wallet; waiting for receipt...`);

  // 2. wait for the target to receive the NIGHT.
  const funded: any = await Rx.firstValueFrom(
    target.wallet.state().pipe(
      Rx.throttleTime(3000),
      Rx.filter((s: any) => s.isSynced && (s.unshielded.balances[NIGHT] ?? 0n) >= nightAmount),
    ),
  );

  // 3. register the received NIGHT for dust generation (documented flow; no signRecipe).
  await target.wallet
    .registerNightUtxosForDustGeneration(
      funded.unshielded.availableCoins,
      target.unshieldedKeystore.getPublicKey(),
      (p) => target.unshieldedKeystore.signData(p),
    )
    .then((r) => target.wallet.finalizeRecipe(r))
    .then((tx) => target.wallet.submitTransaction(tx));
  logger.info('Dust registration submitted; waiting for dust to appear...');

  // 4. wait for a spendable dust (fee) balance to appear.
  const ready: any = await Rx.firstValueFrom(
    target.wallet.state().pipe(
      Rx.throttleTime(5000),
      Rx.filter((s: any) => s.isSynced && readDust(s) > 0n),
    ),
  );
  const dust = readDust(ready);
  logger.info(`Target wallet dust (fee) balance: ${dust}`);
  return dust;
};

// claimRefund with optional coinPublicKey → encryptionPublicKey mappings. The refund
// mints to the caller's own key, so mappings are usually unnecessary, but kept optional.
export const claimRefundWithMappings = async (
  providers: VaultProviders,
  contractAddress: string,
  args: unknown[],
  coinToEncPk?: ReadonlyMap<string, string>,
) => {
  const opts = createCallTxOptions(
    vaultCompiledContract,
    'claimRefund',
    contractAddress as any,
    'vaultPrivateState',
    coinToEncPk as any,
    args as any,
  );
  return submitCallTx(providers as any, opts as any);
};

export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return bytes;
};

export const buildFreshWallet = async (config: Config): Promise<WalletContext> =>
  await buildWalletAndWaitForFunds(config, toHex(randomBytes(32)));

export const configureProviders = async (ctx: WalletContext, config: Config) => {
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(ctx);
  const zkConfigProvider = new NodeZkConfigProvider<'initialize' | 'deposit' | 'claim' | 'withdraw' | 'claimRefund'>(contractConfig.zkConfigPath);
  const accountId = walletAndMidnightProvider.getCoinPublicKey();
  const storagePassword = `${Buffer.from(accountId, 'hex').toString('base64')}!`;
  return {
    privateStateProvider: levelPrivateStateProvider<typeof VaultPrivateStateId>({
      privateStateStoreName: contractConfig.privateStateStoreName,
      accountId,
      privateStoragePasswordProvider: () => storagePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

export function setLogger(_logger: Logger) {
  logger = _logger;
}
