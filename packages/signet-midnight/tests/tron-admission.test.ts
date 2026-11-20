import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import { pureCircuits, type TronTxParams } from "../src/index.ts";
import { Contract } from "../src/managed/contract/index.js";

const CPK = "0".repeat(64);
const contract = new Contract({});
const { currentContractState } = await contract.initialState(createConstructorContext({}, CPK));

// Runs the window check as the ledger does in a block whose time is `blockTime` seconds.
async function windowAtBlockTime(
  blockTime: number,
  expiration: bigint,
  expirationSeconds: bigint,
  minRemainingSeconds: bigint,
  capMarginSeconds: bigint,
): Promise<void> {
  const context = createCircuitContext({
    circuitId: "assertTronExpirationWindowV1",
    contractAddress: sampleContractAddress(),
    coinPublicKeyOrZswapState: CPK,
    contractState: currentContractState,
    privateState: {},
    time: blockTime,
  });
  await contract.circuits.assertTronExpirationWindowV1(
    context,
    expiration,
    expirationSeconds,
    minRemainingSeconds,
    capMarginSeconds,
  );
}

const EXPIRATION_SECONDS = 1_800_000_000n;
const DAY = 86_400;

describe("assertTronExpirationWindowV1", () => {
  // expiration 1_800_000_000_500 ms, minRemaining 60 s, capMargin 300 s: the window admits block
  // times in [1_800_000_000 + 1 + 300 - 86_400, 1_800_000_000 - 60).
  it.each([
    ["the last block time the open check admits", 1_799_999_939],
    ["the first block time the cap check admits", 1_799_913_901],
  ] as const)("admits %s (block time %i)", async (_name, blockTime) => {
    await expect(
      windowAtBlockTime(blockTime, 1_800_000_000_500n, EXPIRATION_SECONDS, 60n, 300n),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["the first block time inside minRemaining", 1_799_999_940, "Tron expiration too close"],
    ["a block time past the expiration", 1_800_000_001, "Tron expiration too close"],
    ["the last block time outside capMargin", 1_799_913_900, "Tron expiration too far"],
    ["a block time more than 24 h before the expiration", 1_799_900_000, "Tron expiration too far"],
  ] as const)("refuses %s (block time %i)", async (_name, blockTime, error) => {
    await expect(
      windowAtBlockTime(blockTime, 1_800_000_000_500n, EXPIRATION_SECONDS, 60n, 300n),
    ).rejects.toThrow(error);
  });

  it.each([
    ["one second too high", 1_800_000_000_999n, 1_800_000_001n],
    ["one second too low", 1_800_000_000_000n, 1_799_999_999n],
    ["the millisecond value itself", 1_800_000_000_000n, 1_800_000_000_000n],
  ] as const)("refuses an expirationSeconds %s", async (_name, expiration, seconds) => {
    await expect(windowAtBlockTime(1_799_990_000, expiration, seconds, 0n, 0n)).rejects.toThrow(
      "expirationSeconds is not the expiration in whole seconds",
    );
  });

  it("accepts the last millisecond of the expiration's second", async () => {
    await expect(
      windowAtBlockTime(1_799_990_000, 1_800_000_000_999n, EXPIRATION_SECONDS, 0n, 0n),
    ).resolves.toBeUndefined();
  });

  it("refuses, without underflowing, a minRemaining longer than the whole expiration", async () => {
    await expect(windowAtBlockTime(0, 50_000n, 50n, 60n, 0n)).rejects.toThrow(
      "Tron expiration too close",
    );
  });

  it("skips the cap check when the expiration is within 24 h of the epoch", async () => {
    await expect(windowAtBlockTime(5, 10_000n, 10n, 0n, 0n)).resolves.toBeUndefined();
  });

  // The MPC admits a request iff blockTime * 1000 < expiration <= blockTime * 1000 + 24 h
  // (node/src/stream/ops.rs expiry_bound, block time in whole seconds). With zero margins the
  // circuit admits no window the MPC refuses, and every window the MPC admits with a second to
  // spare on both sides.
  it.each([0n, 1n, 500n, 999n])(
    "never admits a window the MPC refuses (expiration ...%i ms)",
    async (millis) => {
      const expiration = EXPIRATION_SECONDS * 1000n + millis;
      const near = Number(EXPIRATION_SECONDS);
      const blockTimes = [
        ...Array.from({ length: 5 }, (_, i) => near - 3 + i),
        ...Array.from({ length: 5 }, (_, i) => near - DAY - 3 + i),
      ];
      for (const blockTime of blockTimes) {
        const sourceMs = BigInt(blockTime) * 1000n;
        const mpcAdmits = expiration > sourceMs && expiration <= sourceMs + BigInt(DAY) * 1000n;
        const mpcAdmitsWithSlack =
          expiration > sourceMs + 1000n && expiration <= sourceMs + BigInt(DAY - 1) * 1000n;
        const admitted = await windowAtBlockTime(
          blockTime,
          expiration,
          EXPIRATION_SECONDS,
          0n,
          0n,
        ).then(
          () => true,
          () => false,
        );
        expect({ blockTime, admitted: admitted && !mpcAdmits }).toEqual({
          blockTime,
          admitted: false,
        });
        expect({ blockTime, refused: mpcAdmitsWithSlack && !admitted }).toEqual({
          blockTime,
          refused: false,
        });
      }
    },
  );
});

const INT64_MAX = 2n ** 63n - 1n;

const VALID_TRON_TX_PARAMS: TronTxParams = {
  refBlockBytes: new Uint8Array(2).fill(0x27),
  refBlockHash: new Uint8Array(8).fill(0x42),
  timestamp: 1_800_000_000_000n,
  expiration: 1_800_000_600_000n,
  feeLimit: 100_000_000n,
  contractAddress: Uint8Array.from([0x41, ...new Uint8Array(20).fill(0xaa)]),
  callValue: 0n,
  calldata: {
    is_some: true,
    value: {
      selector: Uint8Array.from([0xa9, 0x05, 0x9c, 0xbb]),
      noWords: 2n,
      words: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
    },
  },
};

describe("assertTronTxParamsV1", () => {
  it.each([
    ["valid params", {}],
    ["int64 maxima", { expiration: INT64_MAX, feeLimit: INT64_MAX, callValue: INT64_MAX }],
  ] as const)("admits %s", (_name, delta: Partial<TronTxParams>) => {
    expect(pureCircuits.assertTronTxParamsV1_2({ ...VALID_TRON_TX_PARAMS, ...delta })).toEqual([]);
  });

  it.each([
    [
      "timestamp past int64",
      { timestamp: INT64_MAX + 1n, expiration: INT64_MAX },
      "Tron timestamp exceeds int64",
    ],
    ["expiration past int64", { expiration: INT64_MAX + 1n }, "Tron expiration exceeds int64"],
    ["fee limit past int64", { feeLimit: INT64_MAX + 1n }, "Tron fee limit exceeds int64"],
    ["call value past int64", { callValue: INT64_MAX + 1n }, "Tron call value exceeds int64"],
    [
      "expiration equal to timestamp",
      { expiration: 1_800_000_000_000n },
      "Tron expiration must follow its timestamp",
    ],
    [
      "expiration before timestamp",
      { expiration: 1_799_999_999_999n },
      "Tron expiration must follow its timestamp",
    ],
  ] as const)("refuses %s", (_name, delta: Partial<TronTxParams>, error) => {
    expect(() =>
      pureCircuits.assertTronTxParamsV1_2({ ...VALID_TRON_TX_PARAMS, ...delta }),
    ).toThrow(error);
  });

  it("pins the protocol constants", () => {
    expect(pureCircuits.tronInt64Max()).toBe(INT64_MAX);
    expect(pureCircuits.tronMaxExpirationSpanSeconds()).toBe(86_400n);
  });
});
