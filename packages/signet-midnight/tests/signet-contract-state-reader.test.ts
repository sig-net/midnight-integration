// Round-trip test for the MPC-/client-style signet contract reader: encode
// all six ledger fields with the canonical descriptors into a synthetic
// StateValue tree (the shape the indexer returns for the signet contract),
// then decode them back by field position alone — no compiled contract
// involved. Mirrors signature-requests-state-reader.test.ts. The notification
// fixtures are packed by the REAL compiled circuit, pinning the pack↔decode
// lockstep in-process.

import { describe, expect, it } from "vitest";

import {
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
} from "@midnight-ntwrk/compact-runtime";

import {
  bytesToHex,
  decodeSignBidirectionalNotification,
  pureCircuits,
  readSignBidirectionalNotificationIndexFromState,
  readSignetContractLedgerFromState,
  requestIdHex,
  requestIdType,
  signatureRespondedEventType,
  respondBidirectionalEventType,
  signBidirectionalNotificationType,
  signetMapEntryKey,
  signetMapKeyType,
  type SignatureRespondedEvent,
  type RespondBidirectionalEvent,
  type SignBidirectionalNotificationRecord,
} from "../src/index.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

const u64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);

const REQUEST_ID = bytes(32, 0x2f);
// Two signature responses posted for REQUEST_ID: counter reads 2, entries at
// counts 0..1. Synthetic signatures — the reader decodes, it does not verify.
const POST_COUNT = 2n;
const RESPONSE_0: SignatureRespondedEvent = {
  signature: { bigR: { x: bytes(32, 0xa0), y: bytes(32, 0xa1) }, s: bytes(32, 0xa2), recoveryId: 0n },
};
const RESPONSE_1: SignatureRespondedEvent = {
  signature: { bigR: { x: bytes(32, 0xb0), y: bytes(32, 0xb1) }, s: bytes(32, 0xb2), recoveryId: 1n },
};

// One respond-bidirectional response for REQUEST_ID, its signature equally
// synthetic.
const RESPOND_BIDIRECTIONAL: RespondBidirectionalEvent = {
  serializedOutput: bytes(128, 0x01),
  outputLen: 32n,
  signature: { bigR: { x: bytes(32, 0x5c), y: bytes(32, 0x5d) }, s: bytes(32, 0x5e), recoveryId: 1n },
};

// One notification registered for REQUEST_ID, packed by the compiled circuit
// (the same packer requester contracts call in-circuit). The request id is
// NOT in the payload — it lives in the SignetMapKey the record is stored
// under.
const CALLER_ADDRESS_BYTES = bytes(32, 0xc1);
const NOTIFICATION = pureCircuits.constructSignBidirectionalEventNotificationV1(
  { bytes: CALLER_ADDRESS_BYTES },
  4n,
);

/** Counter cell as the runtime stores it: a u64 in a plain cell. */
const counterCell = (value: bigint) =>
  StateValue.newCell({ value: u64.toValue(value), alignment: u64.alignment() });

/** A one-entry `Map<RequestId, Counter>` state map. */
const counterMapOf = (count: bigint) =>
  new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    counterCell(count),
  );

const mapKey = (count: bigint) => ({
  value: signetMapKeyType.toValue({ count, requestId: REQUEST_ID }),
  alignment: signetMapKeyType.alignment(),
});

const responseCell = (response: SignatureRespondedEvent) =>
  StateValue.newCell({
    value: signatureRespondedEventType.toValue(response),
    alignment: signatureRespondedEventType.alignment(),
  });

const notificationCell = (record: SignBidirectionalNotificationRecord) =>
  StateValue.newCell({
    value: signBidirectionalNotificationType.toValue(record),
    alignment: signBidirectionalNotificationType.alignment(),
  });

// Contract root state: an array of ledger fields in the signet contract's
// declaration order — notification counter map (0), notification map (1),
// signature counter map (2), signature map (3), respond-bidirectional
// counter map (4), respond-bidirectional map (5).
const syntheticContractState = () => {
  const notificationMap = new StateMap().insert(
    mapKey(0n),
    notificationCell(NOTIFICATION),
  );
  const responseMap = new StateMap()
    .insert(mapKey(0n), responseCell(RESPONSE_0))
    .insert(mapKey(1n), responseCell(RESPONSE_1));
  const respondBidirectionalMap = new StateMap().insert(
    mapKey(0n),
    StateValue.newCell({
      value: respondBidirectionalEventType.toValue(RESPOND_BIDIRECTIONAL),
      alignment: respondBidirectionalEventType.alignment(),
    }),
  );
  return StateValue.newArray()
    .arrayPush(StateValue.newMap(counterMapOf(1n)))
    .arrayPush(StateValue.newMap(notificationMap))
    .arrayPush(StateValue.newMap(counterMapOf(POST_COUNT)))
    .arrayPush(StateValue.newMap(responseMap))
    .arrayPush(StateValue.newMap(counterMapOf(1n)))
    .arrayPush(StateValue.newMap(respondBidirectionalMap));
};

describe("signet-contract-state-reader (MPC-style raw decode)", () => {
  it("round-trips all six ledger fields through raw state by field position", () => {
    const {
      signBidirectionalEventNotificationCounterMap,
      signBidirectionalEventNotificationMap,
      signatureResponseCounterMap,
      signatureResponseMap,
      respondBidirectionalCounterMap,
      respondBidirectionalMap,
    } = readSignetContractLedgerFromState(syntheticContractState());

    const idHex = requestIdHex(REQUEST_ID);

    expect(signBidirectionalEventNotificationCounterMap.get(idHex)).toBe(1n);
    expect(signBidirectionalEventNotificationMap.size).toBe(1);
    expect(signBidirectionalEventNotificationMap.get(idHex)).toEqual(
      NOTIFICATION,
    );

    expect(signatureResponseCounterMap.size).toBe(1);
    expect(signatureResponseCounterMap.get(idHex)).toBe(POST_COUNT);

    expect(signatureResponseMap.size).toBe(2);
    expect(signatureResponseMap.get(signetMapEntryKey(idHex, 0n))).toEqual(
      RESPONSE_0,
    );
    expect(signatureResponseMap.get(signetMapEntryKey(idHex, 1n))).toEqual(
      RESPONSE_1,
    );

    expect(respondBidirectionalCounterMap.get(idHex)).toBe(1n);
    expect(respondBidirectionalMap.size).toBe(1);
    expect(respondBidirectionalMap.get(signetMapEntryKey(idHex, 0n))).toEqual(
      RESPOND_BIDIRECTIONAL,
    );
  });

  it("reads the notification registry alone via the single-field reader", () => {
    const registry = readSignBidirectionalNotificationIndexFromState(
      syntheticContractState(),
    );
    expect(registry.size).toBe(1);
    expect(registry.get(requestIdHex(REQUEST_ID))).toEqual(NOTIFICATION);
  });

  it("keeps the FIRST post per request id when re-notifies appended", () => {
    const second = pureCircuits.constructSignBidirectionalEventNotificationV1(
      { bytes: bytes(32, 0xd2) },
      7n,
    );
    const notificationMap = new StateMap()
      .insert(mapKey(0n), notificationCell(NOTIFICATION))
      .insert(mapKey(1n), notificationCell(second));
    const state = StateValue.newArray()
      .arrayPush(StateValue.newMap(counterMapOf(2n)))
      .arrayPush(StateValue.newMap(notificationMap))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()));

    const registry = readSignBidirectionalNotificationIndexFromState(state);
    expect(registry.size).toBe(1);
    expect(registry.get(requestIdHex(REQUEST_ID))).toEqual(NOTIFICATION);
  });

  it("decodes a circuit-packed notification back to its flat fields (pack↔decode lockstep)", () => {
    expect(decodeSignBidirectionalNotification(NOTIFICATION)).toEqual({
      version: 1,
      callerAddress: bytesToHex(CALLER_ADDRESS_BYTES),
      requestsIndexField: 4,
    });
  });

  it("fails closed decoding an unsupported notification version", () => {
    expect(() =>
      decodeSignBidirectionalNotification({ ...NOTIFICATION, version: 2n }),
    ).toThrow(/version 2 is not supported/);
  });

  it("returns empty indexes for a fresh signet contract", () => {
    const fresh = StateValue.newArray()
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()))
      .arrayPush(StateValue.newMap(new StateMap()));
    const ledger = readSignetContractLedgerFromState(fresh);
    expect(ledger.signBidirectionalEventNotificationCounterMap.size).toBe(0);
    expect(ledger.signBidirectionalEventNotificationMap.size).toBe(0);
    expect(ledger.signatureResponseCounterMap.size).toBe(0);
    expect(ledger.signatureResponseMap.size).toBe(0);
    expect(ledger.respondBidirectionalCounterMap.size).toBe(0);
    expect(ledger.respondBidirectionalMap.size).toBe(0);
  });
});
