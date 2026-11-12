import { describe, expect, it } from "vitest";

import { formatDust, formatNight } from "../src/plumbing/format-amounts.ts";
import { formatFunding, formatUtxoBreakdown } from "../src/plumbing/funding.ts";
import type { FacadeState } from "../src/plumbing/wallet.ts";

describe("formatNight", () => {
  const cases: readonly { stars: bigint; night: string }[] = [
    { stars: 0n, night: "0" },
    { stars: 1n, night: "0.000001" },
    { stars: 100_000n, night: "0.1" },
    { stars: 1_000_000n, night: "1" },
    { stars: 1_234_567_890n, night: "1234.56789" },
    { stars: -2_500_000n, night: "-2.5" },
  ];
  it.each(cases)("formats $stars STARs as $night NIGHT", ({ stars, night }) => {
    expect(formatNight(stars)).toBe(night);
  });
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

describe("formatFunding", () => {
  const ADDRESSES = { unshielded: "", shielded: "", dust: "" };

  interface Case {
    name: string;
    night: bigint;
    dust: bigint;
    balances: string;
  }
  const CASES: Case[] = [
    { name: "an unfunded wallet", night: 0n, dust: 0n, balances: "0 NIGHT, 0 spendable DUST" },
    {
      name: "a funded wallet",
      night: 100_000n,
      dust: 2_500_000_000_000_000n,
      balances: "0.1 NIGHT, 2.5 spendable DUST",
    },
  ];

  it.each(CASES)("writes the balances of $name in whole units", ({ night, dust, balances }) => {
    expect(formatFunding({ addresses: ADDRESSES, night, dust })).toBe(balances);
  });
});

describe("formatUtxoBreakdown", () => {
  it("counts the NIGHT and DUST UTXOs, then itemises each in whole units", () => {
    const unshielded: Partial<FacadeState["unshielded"]> = {
      availableCoins: [
        {
          utxo: { value: 60_000n, owner: "", type: "", intentHash: "", outputNo: 0 },
          meta: { ctime: new Date("2026-11-01T10:00:00.000Z"), registeredForDustGeneration: true },
        },
        {
          utxo: { value: 40_000n, owner: "", type: "", intentHash: "", outputNo: 1 },
          meta: { ctime: new Date("2026-11-02T10:00:00.000Z"), registeredForDustGeneration: false },
        },
      ],
    };
    const token: FacadeState["dust"]["availableCoins"][number]["token"] = {
      initialValue: 0n,
      owner: 0n,
      nonce: 0n,
      seq: 0,
      ctime: new Date(0),
      backingNight: "",
      mtIndex: 0n,
    };
    const dust: Partial<FacadeState["dust"]> = {
      availableCoins: [
        {
          token,
          dtime: undefined,
          maxCap: 300_000_000_000_000n,
          maxCapReachedAt: new Date(0),
          generatedNow: 250_000_000_000_000n,
          rate: 0n,
        },
        {
          token,
          dtime: new Date(0),
          maxCap: 200_000_000_000_000n,
          maxCapReachedAt: new Date(0),
          generatedNow: 1_000_000_000_000n,
          rate: 0n,
        },
      ],
    };
    const state: Partial<FacadeState> = {
      unshielded: unshielded as FacadeState["unshielded"],
      dust: dust as FacadeState["dust"],
    };

    expect(formatUtxoBreakdown(state as FacadeState)).toBe(
      [
        "  NIGHT in 2 UTXO(s), 1 registered for dust generation",
        "    0.06 NIGHT, registered, created 2026-11-01T10:00:00.000Z",
        "    0.04 NIGHT, not registered, created 2026-11-02T10:00:00.000Z",
        "  DUST in 2 UTXO(s)",
        "    0.25 DUST of a 0.3 DUST cap",
        "    0.001 DUST of a 0.2 DUST cap, decaying",
      ].join("\n"),
    );
  });
});
