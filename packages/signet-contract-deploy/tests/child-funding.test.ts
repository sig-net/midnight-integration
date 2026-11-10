import { afterEach, describe, expect, it, vi } from "vitest";

import { fundChildFromRoot } from "../src/plumbing/funding.ts";
import { getMidnightNodeConfig } from "../src/plumbing/midnight-node-config.ts";
import {
  deriveAccountKeys,
  type FacadeState,
  type WalletFacade,
  WalletRegistry,
} from "../src/plumbing/wallet.ts";

afterEach(() => vi.restoreAllMocks());

describe("child funding recheck", () => {
  it("skips root when a child without NIGHT already covers its required fee", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const keys = deriveAccountKeys("01".repeat(32), "preview");
    const dust: Partial<FacadeState["dust"]> = { balance: (): bigint => 50n };
    const unshielded: Partial<FacadeState["unshielded"]> = { balances: {} };
    const state = {
      dust: dust as FacadeState["dust"],
      unshielded: unshielded as FacadeState["unshielded"],
    } as FacadeState;
    const facade = {
      waitForSyncedState: vi.fn().mockResolvedValue(state),
    } as Partial<WalletFacade> as WalletFacade;
    const registry = new WalletRegistry(getMidnightNodeConfig({ NETWORK_ID: "preview" }));
    const open = vi.spyOn(registry, "wallet").mockResolvedValue({ label: "user", facade, keys });
    const result = await fundChildFromRoot(registry, "root", "child", "user", 100n, 50n);
    expect(result.dust).toBe(50n);
    expect(result.night).toBe(0n);
    expect(open).toHaveBeenCalledExactlyOnceWith("child", "user");
  });
});
