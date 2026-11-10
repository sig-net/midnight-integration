import * as ledger from "@midnightntwrk/ledger-v9";
import { ProtocolVersion, WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import { WalletError } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import type { UnprovenTransactionRecipe } from "@midnightntwrk/wallet-sdk-facade";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveAccountKeys,
  deriveAddresses,
  type FacadeState,
  transferNight,
  type WalletFacade,
} from "../src/plumbing/wallet.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setupTransfer() {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const keys = deriveAccountKeys("01".repeat(32), "undeployed");
  const address = deriveAddresses(keys, "undeployed").unshielded;
  const unshielded: Partial<FacadeState["unshielded"]> = {
    balances: { [ledger.nativeToken().raw]: 250_000_000_000_000n },
  };
  const dust: Partial<FacadeState["dust"]> = {
    balance: () => 1_250_000_000_000_000_000_000_000n,
  };
  const partialState: Partial<FacadeState> = {
    unshielded: unshielded as FacadeState["unshielded"],
    dust: dust as FacadeState["dust"],
  };
  const state = partialState as FacadeState;
  const transfer: UnprovenTransactionRecipe = {
    type: "UNPROVEN_TRANSACTION",
    protocolVersion: ProtocolVersion.V9NativeForkVersion,
    transaction: WalletTransaction.adopt(
      "Unproven",
      ledger.Transaction.fromParts("undeployed"),
      ProtocolVersion.V9NativeForkVersion,
    ),
  };
  const facade = {
    transferTransaction: vi.fn<WalletFacade["transferTransaction"]>().mockResolvedValue(transfer),
    balanceUnprovenTransaction: vi
      .fn<WalletFacade["balanceUnprovenTransaction"]>()
      .mockResolvedValue(transfer),
    waitForSyncedState: vi.fn<WalletFacade["waitForSyncedState"]>().mockResolvedValue(state),
    revert: vi.fn<WalletFacade["revert"]>().mockResolvedValue(undefined),
    signRecipe: vi.fn<WalletFacade["signRecipe"]>().mockResolvedValue(transfer),
    finalizeRecipe: vi.fn<WalletFacade["finalizeRecipe"]>(),
    submitTransaction: vi.fn<WalletFacade["submitTransaction"]>(),
  };
  const partialWallet: Partial<WalletFacade> = facade;
  return { keys, address, state, transfer, facade, wallet: partialWallet as WalletFacade };
}

// The dust wallet's own refusal as its `balanceTransactions` rejects with it:
// the typed failure inside the fiber wrapper `Effect.runPromise` throws.
async function dustBalancingRejection(message: string): Promise<unknown> {
  const failure = new WalletError.InsufficientFundsError({ message, tokenType: "dust" });
  return Effect.runPromise(Effect.fail(failure)).catch((rejection: unknown) => rejection);
}

describe("transferNight fee retries", () => {
  it.each([
    "Insufficient Funds: the configured coin selection declined the remaining 5 dust coin(s)",
    "Insufficient Funds: any wording the dust wallet gives its refusal",
  ])("reserves NIGHT once and retries only DUST balancing after: %s", async (message) => {
    const { keys, address, state, transfer, facade, wallet } = setupTransfer();
    const error = await dustBalancingRejection(message);
    facade.balanceUnprovenTransaction.mockRejectedValueOnce(error);
    // The transfer and every balancing attempt expire 30 minutes after the call.
    const expiry = new Date(Date.now() + 30 * 60 * 1000);
    const result = transferNight(wallet, keys, state, address, "undeployed", 124_999_999_999_998n);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(facade.transferTransaction).toHaveBeenCalledOnce();
    expect(facade.transferTransaction.mock.calls.at(0)?.[1].payFees).toBe(false);
    expect(facade.transferTransaction.mock.calls.at(0)?.[1].ttl).toEqual(expiry);
    expect(facade.balanceUnprovenTransaction).toHaveBeenCalledTimes(2);
    for (const [transaction, options] of facade.balanceUnprovenTransaction.mock.calls) {
      expect(transaction).toBe(transfer.transaction);
      expect(options.ttl).toEqual(expiry);
      expect(options.tokenKindsToBalance).toEqual(["dust"]);
    }
    expect(console.warn).toHaveBeenCalledWith("DUST fee balancing failed, retrying:", error);
    expect(facade.revert).not.toHaveBeenCalled();
    expect(facade.submitTransaction).toHaveBeenCalledOnce();
  });

  it("propagates an unshielded funding failure immediately", async () => {
    const { keys, address, state, facade, wallet } = setupTransfer();
    const error = new Error("Wallet.InsufficientFunds: Insufficient funds");
    facade.transferTransaction.mockRejectedValue(error);
    await expect(
      transferNight(wallet, keys, state, address, "undeployed", 124_999_999_999_998n),
    ).rejects.toBe(error);
    expect(facade.transferTransaction).toHaveBeenCalledOnce();
    expect(facade.balanceUnprovenTransaction).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("releases NIGHT at once after a balancing failure that is not a DUST refusal", async () => {
    const { keys, address, state, transfer, facade, wallet } = setupTransfer();
    // A plain error carrying the dust wallet's wording is not its typed failure.
    const error = new Error(
      "Insufficient Funds: the configured coin selection declined the remaining 5 dust coin(s)",
    );
    facade.balanceUnprovenTransaction.mockRejectedValue(error);
    await expect(
      transferNight(wallet, keys, state, address, "undeployed", 124_999_999_999_998n),
    ).rejects.toBe(error);
    expect(facade.balanceUnprovenTransaction).toHaveBeenCalledOnce();
    expect(facade.revert).toHaveBeenCalledExactlyOnceWith(transfer);
    expect(facade.submitTransaction).not.toHaveBeenCalled();
  });

  it("releases NIGHT once the DUST refusal outlasts the retry window", async () => {
    const { keys, address, state, transfer, facade, wallet } = setupTransfer();
    const error = await dustBalancingRejection(
      "Insufficient Funds: the configured coin selection declined the remaining 5 dust coin(s)",
    );
    const wait = 360_000;
    facade.balanceUnprovenTransaction.mockRejectedValue(error);
    await Promise.all([
      expect(
        transferNight(wallet, keys, state, address, "undeployed", 124_999_999_999_998n),
      ).rejects.toBe(error),
      vi.advanceTimersByTimeAsync(wait),
    ]);
    expect(facade.transferTransaction).toHaveBeenCalledOnce();
    expect(facade.revert).toHaveBeenCalledExactlyOnceWith(transfer);
    expect(facade.signRecipe).not.toHaveBeenCalled();
    expect(facade.submitTransaction).not.toHaveBeenCalled();
  });
});
