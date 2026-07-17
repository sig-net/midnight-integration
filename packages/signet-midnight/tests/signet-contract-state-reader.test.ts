// Round-trip test for the MPC-/client-style signet contract reader: encode
// all five ledger fields with the canonical descriptors into a synthetic
// StateValue tree (the shape the indexer returns for the signet contract),
// then decode them back by field position alone — no compiled contract
// involved. Mirrors signature-requests-state-reader.test.ts. The notification
// fixtures are packed by the REAL compiled circuit, pinning the pack↔decode
// lockstep in-process.

import { describe, expect, it } from "vitest";

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  StateMap,
  StateValue,
} from "@midnight-ntwrk/compact-runtime";

import {
  bytesToHex,
  decodeSignBidirectionalNotification,
  deriveJubjubKeypair,
  pureCircuits,
  readSignBidirectionalNotificationIndexFromState,
  readSignetContractLedgerFromState,
  requestIdHex,
  requestIdType,
  signatureResponseType,
  respondBidirectionalType,
  signBidirectionalNotificationType,
  signetResponseIndexKey,
  signetResponseKeyType,
  type SignatureResponse,
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
const RESPONSE_0: SignatureResponse = {
  bigRx: bytes(32, 0xa0),
  bigRy: bytes(32, 0xa1),
  s: bytes(32, 0xa2),
  recoveryId: 0n,
};
const RESPONSE_1: SignatureResponse = {
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

// One notification registered for REQUEST_ID, packed by the compiled circuit
// (the same packer requester contracts call in-circuit).
const CALLER_ADDRESS_BYTES = bytes(32, 0xc1);
const NOTIFICATION = pureCircuits.constructSignBidirectionalNotificationV1(
  { bytes: CALLER_ADDRESS_BYTES },
  REQUEST_ID,
  0n,
);

/** Counter cell as the runtime stores it: a u64 in a plain cell. */
const counterCell = (value: bigint) =>
  StateValue.newCell({ value: u64.toValue(value), alignment: u64.alignment() });

const responseCell = (response: SignatureResponse) =>
  StateValue.newCell({
    value: signatureResponseType.toValue(response),
    alignment: signatureResponseType.alignment(),
  });

const responseKey = (count: bigint) => ({
  value: signetResponseKeyType.toValue({ count, requestId: REQUEST_ID }),
  alignment: signetResponseKeyType.alignment(),
});

// Contract root state: an array of ledger fields per the signet contract
// layout convention — signature counter index (0), signature log (1),
// respond-bidirectional index (2), sealed MPC key hash (3), notification
// registry (4).
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
  const notificationMap = new StateMap().insert(
    {
      value: requestIdType.toValue(REQUEST_ID),
      alignment: requestIdType.alignment(),
    },
    StateValue.newCell({
      value: signBidirectionalNotificationType.toValue(NOTIFICATION),
      alignment: signBidirectionalNotificationType.alignment(),
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
    )
    .arrayPush(StateValue.newMap(notificationMap));
};

describe("signet-contract-state-reader (MPC-style raw decode)", () => {
  it("round-trips all five ledger fields through raw state by field position", () => {
    const {
      signatureResponseCounterIndex,
      signatureResponseIndex,
      respondBidirectionalIndex,
      mpcPubKeyHash,
      signBidirectionalNotificationIndex,
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

    expect(respondBidirectionalIndex.size).toBe(1);
    expect(respondBidirectionalIndex.get(requestIdHex(REQUEST_ID))).toEqual(
      RESPOND_BIDIRECTIONAL,
    );

    expect(mpcPubKeyHash).toEqual(MPC_PUB_KEY_HASH);

    expect(signBidirectionalNotificationIndex.size).toBe(1);
    expect(signBidirectionalNotificationIndex.get(requestIdHex(REQUEST_ID))).toEqual(
      NOTIFICATION,
    );
  });

  it("reads the notification registry alone via the single-field reader", () => {
    const registry = readSignBidirectionalNotificationIndexFromState(
      syntheticContractState(),
    );
    expect(registry.size).toBe(1);
    expect(registry.get(requestIdHex(REQUEST_ID))).toEqual(NOTIFICATION);
  });

  it("decodes a circuit-packed notification back to its flat fields (pack↔decode lockstep)", () => {
    expect(decodeSignBidirectionalNotification(NOTIFICATION)).toEqual({
      version: 1,
      callerAddress: bytesToHex(CALLER_ADDRESS_BYTES),
      requestId: requestIdHex(REQUEST_ID),
      requestsIndexField: 0,
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
      .arrayPush(
        StateValue.newCell({
          value: bytes32.toValue(MPC_PUB_KEY_HASH),
          alignment: bytes32.alignment(),
        }),
      )
      .arrayPush(StateValue.newMap(new StateMap()));
    const {
      signatureResponseCounterIndex,
      signatureResponseIndex,
      respondBidirectionalIndex,
      mpcPubKeyHash,
      signBidirectionalNotificationIndex,
    } = readSignetContractLedgerFromState(fresh);
    expect(signatureResponseCounterIndex.size).toBe(0);
    expect(signatureResponseIndex.size).toBe(0);
    expect(respondBidirectionalIndex.size).toBe(0);
    expect(mpcPubKeyHash).toEqual(MPC_PUB_KEY_HASH);
    expect(signBidirectionalNotificationIndex.size).toBe(0);
  });
});
