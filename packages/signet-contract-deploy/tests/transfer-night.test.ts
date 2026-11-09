import * as ledger from "@midnightntwrk/ledger-v9";
import { ProtocolVersion, WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import type { UnprovenTransactionRecipe } from "@midnightntwrk/wallet-sdk-facade";
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

describe("transferNight fee retries", () => {
  it.each([
    "Wallet.InsufficientFunds: Insufficient Funds: could not balance dust",
    "Wallet.InsufficientFunds: Insufficient Funds: the configured coin selection declined the remaining 5 dust coin(s)",
  ])("reserves NIGHT once and retries only DUST balancing after: %s", async (message) => {
    const { keys, address, state, transfer, facade, wallet } = setupTransfer();
    const error = new Error(message);
    facade.balanceUnprovenTransaction.mockRejectedValueOnce(error);
    const result = transferNight(wallet, keys, state, address, "undeployed", 124_999_999_999_998n);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(facade.transferTransaction).toHaveBeenCalledOnce();
    expect(facade.transferTransaction.mock.calls.at(0)?.[1].payFees).toBe(false);
    expect(facade.balanceUnprovenTransaction).toHaveBeenCalledTimes(2);
    for (const [transaction, options] of facade.balanceUnprovenTransaction.mock.calls) {
      expect(transaction).toBe(transfer.transaction);
      expect(options.ttl).toBeInstanceOf(Date);
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

  it.each([
    { message: "Wallet.InsufficientFunds: Insufficient funds", wait: 0 },
    {
      message: "Wallet.InsufficientFunds: Insufficient Funds: could not balance dust",
      wait: 360_000,
    },
  ])("releases NIGHT after terminal balancing failure: $message", async ({ message, wait }) => {
    const { keys, address, state, transfer, facade, wallet } = setupTransfer();
    const error = new Error(message);
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
