// Round-trip test for the MPC-/client-style signet contract reader: encode
// all four ledger fields with the canonical descriptors into a synthetic
// StateValue tree (the shape the indexer returns for the signet contract),
// then decode them back by field position alone — no compiled contract
// involved. Mirrors signature-requests-state-reader.test.ts.

import { describe, expect, it } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
} from "@midnight-ntwrk/compact-runtime";

import {
  deriveJubjubKeypair,
  readSignetContractLedgerFromState,
  requestIdHex,
  requestIdType,
  signetRemoteExecutionResponseType,
  signetResponseIndexKey,
  signetResponseKeyType,
  type SignetRemoteExecutionResponse,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const bytes65 = new CompactTypeBytes(65);
const bytes32 = new CompactTypeBytes(32);

const REQUEST_ID = bytes(32, 0x2f);
// Two signature responses posted for REQUEST_ID: counter reads 2, entries at
// counts 0..1.
const POST_COUNT = 2n;
const RESPONSE_0 = bytes(65, 0xa0);
const RESPONSE_1 = bytes(65, 0xa1);

// One remote execution response for REQUEST_ID — real Jubjub points so the
// descriptor round-trips genuine coordinates, but a synthetic scalar (the
// reader decodes, it does not verify).
const MPC_KEYS = deriveJubjubKeypair(bytes(32, 0x42));
const EXECUTION_RESPONSE: SignetRemoteExecutionResponse = {
  outputData: bytes(4096, 0x01),
  pk: MPC_KEYS.pk,
  announcement: deriveJubjubKeypair(bytes(32, 0x43)).pk,
  response: 123456789n,
};

const MPC_PUB_KEY_HASH = bytes(32, 0x99);

/** Counter cell as the runtime stores it: a u64 in a plain cell. */
const counterCell = (value: bigint) =>
  StateValue.newCell({ value: u64.toValue(value), alignment: u64.alignment() });

const responseCell = (response: Uint8Array) =>
  StateValue.newCell({
    value: bytes65.toValue(response),
    alignment: bytes65.alignment(),
  });

const responseKey = (count: bigint) => ({
  value: signetResponseKeyType.toValue({ count, requestId: REQUEST_ID }),
  alignment: signetResponseKeyType.alignment(),
});

// Contract root state: an array of ledger fields per the signet contract
// layout convention — signature counter index (0), signature log (1), remote
// execution response index (2), sealed MPC key hash (3).
const syntheticContractState = () => {
  const counterMap = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    counterCell(POST_COUNT),
  );
  const responseMap = new StateMap()
    .insert(responseKey(0n), responseCell(RESPONSE_0))
    .insert(responseKey(1n), responseCell(RESPONSE_1));
  const executionMap = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    StateValue.newCell({
      value: signetRemoteExecutionResponseType.toValue(EXECUTION_RESPONSE),
      alignment: signetRemoteExecutionResponseType.alignment(),
    }),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(counterMap))
    .arrayPush(StateValue.newMap(responseMap))
    .arrayPush(StateValue.newMap(executionMap))
    .arrayPush(
      StateValue.newCell({
        value: bytes32.toValue(MPC_PUB_KEY_HASH),
        alignment: bytes32.alignment(),
      }),
    );
};

describe("signet-contract-state-reader (MPC-style raw decode)", () => {
  it("round-trips all four ledger fields through raw state by field position", () => {
    const {
      signatureResponseCounterIndex,
      signatureResponseIndex,
      remoteExecutionResponseIndex,
      mpcPubKeyHash,
    } = readSignetContractLedgerFromState(syntheticContractState());

    expect(signatureResponseCounterIndex.size).toBe(1);
    expect(signatureResponseCounterIndex.get(requestIdHex(REQUEST_ID))).toBe(
      POST_COUNT,
    );

    expect(signatureResponseIndex.size).toBe(2);
    expect(
      signatureResponseIndex.get(signetResponseIndexKey(requestIdHex(REQUEST_ID), 0n)),
    ).toEqual(RESPONSE_0);
    expect(
      signatureResponseIndex.get(signetResponseIndexKey(requestIdHex(REQUEST_ID), 1n)),
    ).toEqual(RESPONSE_1);

    expect(remoteExecutionResponseIndex.size).toBe(1);
    expect(remoteExecutionResponseIndex.get(requestIdHex(REQUEST_ID))).toEqual(
      EXECUTION_RESPONSE,
    );

    expect(mpcPubKeyHash).toEqual(MPC_PUB_KEY_HASH);
  });

  it("returns empty indexes for a fresh signet contract", () => {
    const fresh = StateValue.newArray()
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(
        StateValue.newCell({
          value: bytes32.toValue(MPC_PUB_KEY_HASH),
          alignment: bytes32.alignment(),
        }),
      );
    const {
      signatureResponseCounterIndex,
      signatureResponseIndex,
      remoteExecutionResponseIndex,
      mpcPubKeyHash,
    } = readSignetContractLedgerFromState(fresh);
    expect(signatureResponseCounterIndex.size).toBe(0);
    expect(signatureResponseIndex.size).toBe(0);
    expect(remoteExecutionResponseIndex.size).toBe(0);
    expect(mpcPubKeyHash).toEqual(MPC_PUB_KEY_HASH);
  });
});
