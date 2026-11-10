import { afterEach, describe, expect, it, vi } from "vitest";

import { formatDust } from "../src/plumbing/format-dust.ts";
import { ensureFeeReady } from "../src/plumbing/funding.ts";
import { deriveAccountKeys, type FacadeState, type WalletFacade } from "../src/plumbing/wallet.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("formatDust", () => {
  const cases: readonly { specks: bigint; dust: string }[] = [
    { specks: 0n, dust: "0" },
    { specks: 1n, dust: "0.000000000000001" },
    { specks: 1_000_000_000_000_000n, dust: "1" },
    { specks: 44_177_741_500_169_214n, dust: "44.177741500169214" },
    { specks: -2_500_000_000_000_000n, dust: "-2.5" },
  ];
  it.each(cases)("formats $specks SPECKs as $dust DUST", ({ specks, dust }) => {
    expect(formatDust(specks)).toBe(dust);
  });
});

describe("ensureFeeReady funding deadline", () => {
  it("waits beyond five minutes when the caller provides a longer deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const unshielded: Partial<FacadeState["unshielded"]> = {
      balances: { NIGHT: 1n },
      availableCoins: [],
    };
    const dust: Partial<FacadeState["dust"]> = {
      balance: (): bigint => (Date.now() >= 360_000 ? 2_000_000_000_000_000n : 0n),
    };
    const state: Partial<FacadeState> = {
      unshielded: unshielded as FacadeState["unshielded"],
      dust: dust as FacadeState["dust"],
    };
    const facade: Partial<WalletFacade> = {
      waitForSyncedState: vi
        .fn<WalletFacade["waitForSyncedState"]>()
        .mockResolvedValue(state as FacadeState),
    };
    const keys = deriveAccountKeys("01".repeat(32), "preview");
    const result = ensureFeeReady(
      facade as WalletFacade,
      keys,
      state as FacadeState,
      "preview",
      undefined,
      2_000_000_000_000_000n,
      1_200_000,
    );
    await vi.advanceTimersByTimeAsync(360_000);
    await expect(result).resolves.toBe(2_000_000_000_000_000n);
    expect(console.log).toHaveBeenCalledWith(
      "waiting for spendable DUST (have 0, need at least 2)...",
    );
  });

  it("keeps the five-minute default and reports decimal DUST on timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const unshielded: Partial<FacadeState["unshielded"]> = {
      balances: { NIGHT: 1n },
      availableCoins: [],
    };
    const dust: Partial<FacadeState["dust"]> = { balance: (): bigint => 1_000_000_000_000_000n };
    const state: Partial<FacadeState> = {
      unshielded: unshielded as FacadeState["unshielded"],
      dust: dust as FacadeState["dust"],
    };
    const facade: Partial<WalletFacade> = {
      waitForSyncedState: vi
        .fn<WalletFacade["waitForSyncedState"]>()
        .mockResolvedValue(state as FacadeState),
    };
    const keys = deriveAccountKeys("01".repeat(32), "preview");
    await Promise.all([
      expect(
        ensureFeeReady(
          facade as WalletFacade,
          keys,
          state as FacadeState,
          "preview",
          undefined,
          2_000_000_000_000_000n,
        ),
      ).rejects.toThrow("spendable DUST reached 1 of the 2 needed after 300000 ms"),
      vi.advanceTimersByTimeAsync(300_000),
    ]);
  });
});
