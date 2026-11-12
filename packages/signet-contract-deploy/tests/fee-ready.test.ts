// The fee-ready test over a measured funding snapshot, and the fee overhead a
// facade defaults to per network. Pure: no facade, no network.

import { describe, expect, it } from "vitest";

import {
  type AccountFunding,
  defaultAdditionalFeeOverhead,
  isFeeReady,
  MidnightNetwork,
} from "../src/index.ts";

const ADDRESSES = { unshielded: "mn_addr…", shielded: "mn_shield-addr…", dust: "mn_dust…" };

describe("isFeeReady", () => {
  /** One funding snapshot, the minimum asked for, and the verdict. */
  interface ReadyCase {
    readonly name: string;
    readonly funding: AccountFunding;
    readonly minimumDust: bigint | undefined;
    readonly ready: boolean;
  }

  const CASES: readonly ReadyCase[] = [
    {
      name: "NIGHT with any dust, no minimum",
      funding: { addresses: ADDRESSES, night: 10n, dust: 1n },
      minimumDust: undefined,
      ready: true,
    },
    {
      name: "NIGHT without dust",
      funding: { addresses: ADDRESSES, night: 10n, dust: 0n },
      minimumDust: undefined,
      ready: false,
    },
    {
      name: "dust without NIGHT",
      funding: { addresses: ADDRESSES, night: 0n, dust: 5n },
      minimumDust: undefined,
      ready: true,
    },
    {
      name: "dust exactly at the minimum",
      funding: { addresses: ADDRESSES, night: 10n, dust: 500n },
      minimumDust: 500n,
      ready: true,
    },
    {
      name: "dust below the minimum",
      funding: { addresses: ADDRESSES, night: 10n, dust: 499n },
      minimumDust: 500n,
      ready: false,
    },
  ];

  it.each(CASES)("$name", ({ funding, minimumDust, ready }) => {
    expect(minimumDust === undefined ? isFeeReady(funding) : isFeeReady(funding, minimumDust)).toBe(
      ready,
    );
  });
});

describe("defaultAdditionalFeeOverhead", () => {
  /** One network and the overhead a facade there burns on top of every fee. */
  interface OverheadCase {
    readonly networkId: MidnightNetwork;
    readonly overhead: bigint;
  }

  const CASES: readonly OverheadCase[] = [
    { networkId: MidnightNetwork.Undeployed, overhead: 50_000_000_000_000n },
    { networkId: MidnightNetwork.Preview, overhead: 0n },
    { networkId: MidnightNetwork.Preprod, overhead: 0n },
    { networkId: MidnightNetwork.Mainnet, overhead: 0n },
  ];

  it.each(CASES)("burns $overhead on $networkId", ({ networkId, overhead }) => {
    expect(defaultAdditionalFeeOverhead(networkId)).toBe(overhead);
  });
});
