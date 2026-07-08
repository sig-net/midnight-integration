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
  signatureRespondedEventType,
  respondBidirectionalType,
  signetResponseIndexKey,
  signetResponseKeyType,
  type SignatureRespondedEvent,
  type RespondBidirectional,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const bytes32 = new CompactTypeBytes(32);

const REQUEST_ID = bytes(32, 0x2f);
// Two signature responses posted for REQUEST_ID: counter reads 2, entries at
// counts 0..1.
const POST_COUNT = 2n;
const RESPONSE_0: SignatureRespondedEvent = {
  bigRx: bytes(32, 0xa0),
  bigRy: bytes(32, 0xa1),
  s: bytes(32, 0xa2),
  recoveryId: 0n,
};
const RESPONSE_1: SignatureRespondedEvent = {
  bigRx: bytes(32, 0xb0),
  bigRy: bytes(32, 0xb1),
  s: bytes(32, 0xb2),
  recoveryId: 1n,
};

// One respond-bidirectional attestation for REQUEST_ID — real Jubjub points
// so the descriptor round-trips genuine coordinates, but a synthetic scalar
// (the reader decodes, it does not verify).
const MPC_KEYS = deriveJubjubKeypair(bytes(32, 0x42));
const RESPOND_BIDIRECTIONAL: RespondBidirectional = {
  serializedOutput: bytes(128, 0x01),
  outputLen: 32n,
  pk: MPC_KEYS.pk,
  announcement: deriveJubjubKeypair(bytes(32, 0x43)).pk,
  response: 123456789n,
};

const MPC_PUB_KEY_HASH = bytes(32, 0x99);

/** Counter cell as the runtime stores it: a u64 in a plain cell. */
const counterCell = (value: bigint) =>
  StateValue.newCell({ value: u64.toValue(value), alignment: u64.alignment() });

const responseCell = (response: SignatureRespondedEvent) =>
  StateValue.newCell({
    value: signatureRespondedEventType.toValue(response),
    alignment: signatureRespondedEventType.alignment(),
  });

const responseKey = (count: bigint) => ({
  value: signetResponseKeyType.toValue({ count, requestId: REQUEST_ID }),
  alignment: signetResponseKeyType.alignment(),
});

// Contract root state: an array of ledger fields per the signet contract
// layout convention — signature counter index (0), signature log (1),
// respond-bidirectional index (2), sealed MPC key hash (3).
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
  const respondBidirectionalMap = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    StateValue.newCell({
      value: respondBidirectionalType.toValue(RESPOND_BIDIRECTIONAL),
      alignment: respondBidirectionalType.alignment(),
    }),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(counterMap))
    .arrayPush(StateValue.newMap(responseMap))
    .arrayPush(StateValue.newMap(respondBidirectionalMap))
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
      signatureRespondedEventCounterIndex,
      signatureRespondedEventIndex,
      respondBidirectionalIndex,
      mpcPubKeyHash,
    } = readSignetContractLedgerFromState(syntheticContractState());

    expect(signatureRespondedEventCounterIndex.size).toBe(1);
    expect(signatureRespondedEventCounterIndex.get(requestIdHex(REQUEST_ID))).toBe(
      POST_COUNT,
    );

    expect(signatureRespondedEventIndex.size).toBe(2);
    expect(
      signatureRespondedEventIndex.get(signetResponseIndexKey(requestIdHex(REQUEST_ID), 0n)),
    ).toEqual(RESPONSE_0);
    expect(
      signatureRespondedEventIndex.get(signetResponseIndexKey(requestIdHex(REQUEST_ID), 1n)),
    ).toEqual(RESPONSE_1);

    expect(respondBidirectionalIndex.size).toBe(1);
    expect(respondBidirectionalIndex.get(requestIdHex(REQUEST_ID))).toEqual(
      RESPOND_BIDIRECTIONAL,
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
      signatureRespondedEventCounterIndex,
      signatureRespondedEventIndex,
      respondBidirectionalIndex,
      mpcPubKeyHash,
    } = readSignetContractLedgerFromState(fresh);
    expect(signatureRespondedEventCounterIndex.size).toBe(0);
    expect(signatureRespondedEventIndex.size).toBe(0);
    expect(respondBidirectionalIndex.size).toBe(0);
    expect(mpcPubKeyHash).toEqual(MPC_PUB_KEY_HASH);
  });
});
