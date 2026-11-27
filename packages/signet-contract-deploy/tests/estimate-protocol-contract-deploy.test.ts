import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DeployTransactionBuilder,
  estimateProtocolContractDeploy,
} from "../src/deploy-protocol-contract.ts";
import { getMidnightNodeConfig } from "../src/plumbing/midnight-node-config.ts";
import {
  deriveAccountKeys,
  deriveAddresses,
  type FacadeState,
  type WalletFacade,
  WalletRegistry,
} from "../src/plumbing/wallet.ts";

afterEach(() => vi.restoreAllMocks());

describe("estimateProtocolContractDeploy", () => {
  it("prices the deploy of a wallet holding NIGHT and no DUST without submitting or registering NIGHT", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    const env = { NETWORK_ID: "preview", DEPLOYER_SEED: "01".repeat(32) };
    const keys = deriveAccountKeys("01".repeat(32), "preview");
    const dust: Partial<FacadeState["dust"]> = { balance: (): bigint => 0n, availableCoins: [] };
    const unshielded: Partial<FacadeState["unshielded"]> = {
      balances: { ["00".repeat(32)]: 7n },
      availableCoins: [],
    };
    const state = {
      dust: dust as FacadeState["dust"],
      unshielded: unshielded as FacadeState["unshielded"],
    } as FacadeState;
    const registerNightUtxosForDustGeneration = vi.fn();
    const transferTransaction = vi.fn();
    const balanceUnprovenTransaction = vi.fn();
    const signRecipe = vi.fn();
    const finalizeRecipe = vi.fn();
    const submitTransaction = vi.fn();
    const facade = {
      waitForSyncedState: vi.fn().mockResolvedValue(state),
      adoptTransaction: vi.fn(),
      calculateTransactionFee: vi.fn().mockResolvedValue(300n),
      registerNightUtxosForDustGeneration,
      transferTransaction,
      balanceUnprovenTransaction,
      signRecipe,
      finalizeRecipe,
      submitTransaction,
    } as Partial<WalletFacade> as WalletFacade;
    const registry = new WalletRegistry(getMidnightNodeConfig(env), env);
    vi.spyOn(registry, "wallet").mockResolvedValue({ label: "deployer", facade, keys });
    const buildTransaction = vi.fn<DeployTransactionBuilder>().mockResolvedValue({
      contractAddress: "ab".repeat(32),
      serializedTransaction: new Uint8Array([1]),
    });

    const estimate = await estimateProtocolContractDeploy(
      "signet-signer",
      buildTransaction,
      env,
      registry,
    );

    expect(estimate).toEqual({
      contractAddress: "ab".repeat(32),
      fee: 300n,
      funding: { addresses: deriveAddresses(keys, "preview"), night: 7n, dust: 0n },
    });
    expect(registerNightUtxosForDustGeneration).not.toHaveBeenCalled();
    expect(transferTransaction).not.toHaveBeenCalled();
    expect(balanceUnprovenTransaction).not.toHaveBeenCalled();
    expect(signRecipe).not.toHaveBeenCalled();
    expect(finalizeRecipe).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  });
});
