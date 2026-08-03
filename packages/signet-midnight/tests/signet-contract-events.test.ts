// Unit tests for the signet contract event decoders: payload decode twins,
// the simulator-log bridge, and the indexer provider adapter, over fixtures
// built by the test-local encode twins (signet-event-fixtures.ts). The
// notification fixtures are packed by the REAL compiled circuit, pinning
// that pack↔decode lockstep in-process; the event-envelope lockstep against
// the real contract emits is pinned by the signet-contract package's
// simulator tests.

import { describe, expect, it } from "vitest";

import { CompactTypeBytes, type LogEvent } from "@midnight-ntwrk/compact-runtime";

import {
  bytesToHex,
  decodeRespondBidirectionalEventPayload,
  decodeSignatureRespondedEventPayload,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetEventName,
  decodeSignetLogEvents,
  pureCircuits,
  signetEventSourceFromPublicDataProvider,
  asciiPadded,
  SIGNET_EVENT_NAME_LENGTH,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
} from "../src/index.ts";

import {
  notificationEventOf,
  respondBidirectionalEventOf,
  signatureRespondedEventOf,
} from "./signet-event-fixtures.ts";

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// One notification registered by a caller at field 4, packed by the compiled
// circuit (the same packer client contracts call in-circuit).
const CALLER_ADDRESS_BYTES = bytes(32, 0xc1);
const NOTIFICATION = pureCircuits.constructSignBidirectionalEventNotificationV1(
  { bytes: CALLER_ADDRESS_BYTES },
  1n,
  [4n, 0n, 0n, 0n],
);

// Synthetic signatures (the decoders decode, they do not verify). recoveryId
// 1 on RESPONSE so a decoder that dropped the byte cannot match a 0 default.
const RESPONSE: SignatureRespondedEvent = {
  signature: { bigR: { x: bytes(32, 0xa0), y: bytes(32, 0xa1) }, s: bytes(32, 0xa2), recoveryId: 1n },
};
const RESPOND_BIDIRECTIONAL: RespondBidirectionalEvent = {
  signature: { bigR: { x: bytes(32, 0x5c), y: bytes(32, 0x5d) }, s: bytes(32, 0x5e), recoveryId: 1n },
};

describe("decodeSignetEventName", () => {
  it("strips the NUL padding the contract's pad(32, ...) adds", () => {
    expect(
      decodeSignetEventName(asciiPadded("SignatureRespondedEvent", 32)),
    ).toBe(SignetEventName.SignatureRespondedEvent);
  });

  it("keeps an unpadded name verbatim", () => {
    expect(decodeSignetEventName(asciiPadded("x".repeat(32), 32))).toBe(
      "x".repeat(32),
    );
  });
});

describe("notification event payload (pack↔decode lockstep)", () => {
  it("decodes a circuit-packed notification back to its fields", () => {
    const event = notificationEventOf(NOTIFICATION);
    const record = decodeSignBidirectionalEventNotificationPayload(event.payload);
    expect(record).toEqual(NOTIFICATION);
    expect(decodeSignBidirectionalNotification(record)).toEqual({
      version: 1,
      callerAddress: bytesToHex(CALLER_ADDRESS_BYTES),
      requestsPath: [4],
    });
  });

  it("fails closed decoding an unsupported notification version", () => {
    expect(() =>
      decodeSignBidirectionalNotification({ ...NOTIFICATION, version: 2n }),
    ).toThrow(/version 2 is not supported/);
  });

  it("rejects a payload too short to hold the record", () => {
    expect(() =>
      decodeSignBidirectionalEventNotificationPayload(bytes(64, 1)),
    ).toThrow(/too short/);
  });
});

describe("respond event payloads (encode↔decode round trip)", () => {
  it("round-trips a signature response", () => {
    expect(
      decodeSignatureRespondedEventPayload(
        signatureRespondedEventOf(RESPONSE).payload,
      ),
    ).toEqual(RESPONSE);
  });

  it("round-trips a respond-bidirectional attestation", () => {
    expect(
      decodeRespondBidirectionalEventPayload(
        respondBidirectionalEventOf(RESPOND_BIDIRECTIONAL).payload,
      ),
    ).toEqual(RESPOND_BIDIRECTIONAL);
  });

  it("rejects a payload too short to hold a signature", () => {
    expect(() => decodeSignatureRespondedEventPayload(bytes(96, 1))).toThrow(
      /too short/,
    );
  });
});

// A simulator LogEvent for a misc emission of `name` ++ `payload`, its value
// trailing-zero-trimmed exactly as the state layer stores atoms.
const logEventOf = (
  name: string,
  payload: Uint8Array,
  address = "aa".repeat(32),
): LogEvent => {
  const full = new Uint8Array(
    SIGNET_EVENT_NAME_LENGTH + SIGNET_EVENT_PAYLOAD_LENGTH,
  );
  full.set(asciiPadded(name, SIGNET_EVENT_NAME_LENGTH), 0);
  full.set(payload, SIGNET_EVENT_NAME_LENGTH);
  let end = full.length;
  while (end > 0 && full[end - 1] === 0) end -= 1;
  return {
    version: 1,
    eventType: "misc",
    data: {
      tag: "cell",
      content: {
        value: [full.slice(0, end)],
        alignment: new CompactTypeBytes(full.length).alignment(),
      },
    },
    address,
  };
};

describe("decodeSignetLogEvents (simulator bridge)", () => {
  it("decodes misc emissions, re-padding the trimmed trailing zeros", () => {
    const decoded = decodeSignetLogEvents([
      logEventOf(SignetEventName.SignatureRespondedEvent, signatureRespondedEventOf(RESPONSE).payload),
    ]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].name).toBe(SignetEventName.SignatureRespondedEvent);
    expect(decoded[0].payload).toHaveLength(SIGNET_EVENT_PAYLOAD_LENGTH);
    expect(decodeSignatureRespondedEventPayload(decoded[0].payload)).toEqual(RESPONSE);
  });

  it("filters by emitting contract address when one is given", () => {
    const event = logEventOf(
      SignetEventName.SignatureRespondedEvent,
      signatureRespondedEventOf(RESPONSE).payload,
      "bb".repeat(32),
    );
    expect(decodeSignetLogEvents([event], "aa".repeat(32))).toHaveLength(0);
    expect(decodeSignetLogEvents([event], "bb".repeat(32))).toHaveLength(1);
  });

  it("skips non-misc log events", () => {
    const shielded: LogEvent = {
      version: 1,
      eventType: "shielded-spend",
      data: { tag: "null" },
      address: "aa".repeat(32),
    };
    expect(decodeSignetLogEvents([shielded])).toHaveLength(0);
  });

  it("throws on a misc event whose data is not a cell", () => {
    const malformed: LogEvent = {
      version: 1,
      eventType: "misc",
      data: { tag: "null" },
      address: "aa".repeat(32),
    };
    expect(() => decodeSignetLogEvents([malformed])).toThrow(/expected a cell/);
  });
});

describe("signetEventSourceFromPublicDataProvider (indexer adapter)", () => {
  const SIGNET_ADDRESS = "signet-contract-address";

  it("queries Misc events and normalizes hex name/payload into signet events", async () => {
    const served = signatureRespondedEventOf(RESPONSE);
    // The indexer serves hex strings, the payload's trailing zeros trimmed
    // like any stored atom.
    let trimmed = served.payload.length;
    while (trimmed > 0 && served.payload[trimmed - 1] === 0) trimmed -= 1;
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: async (filter) => {
        expect(filter).toEqual({
          contractAddress: SIGNET_ADDRESS,
          types: ["Misc"],
        });
        return [
          {
            eventType: "Misc",
            name: bytesToHex(asciiPadded(served.name, SIGNET_EVENT_NAME_LENGTH)),
            payload: `0x${bytesToHex(served.payload.slice(0, trimmed))}`,
          },
        ];
      },
    });

    const events = await source.querySignetEvents(SIGNET_ADDRESS);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe(SignetEventName.SignatureRespondedEvent);
    expect(events[0].payload).toHaveLength(SIGNET_EVENT_PAYLOAD_LENGTH);
    expect(decodeSignatureRespondedEventPayload(events[0].payload)).toEqual(RESPONSE);
  });

  it("drops non-Misc events and Misc events missing name or payload", async () => {
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: async () => [
        { eventType: "Paused" },
        { eventType: "Misc", name: bytesToHex(asciiPadded("x", 32)) },
      ],
    });
    expect(await source.querySignetEvents(SIGNET_ADDRESS)).toHaveLength(0);
  });
});
