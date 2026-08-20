// Unit tests for the signet contract event decoders: payload decode twins,
// the simulator-log bridge, and the indexer provider adapter, over fixtures
// built by the test-local encode twins (signet-event-fixtures.ts). The
// notification fixtures are packed by the REAL compiled circuit, pinning
// that pack↔decode lockstep in-process; the event-envelope lockstep against
// the real contract emits is pinned by the signet-contract package's
// simulator tests.

import { CompactTypeBytes, type LogEvent } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  asciiPadded,
  bytesToHex,
  decodeRespondBidirectionalEventPayload,
  decodeSignatureRespondedEventPayload,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetEventName,
  decodeSignetLogEvents,
  pureCircuits,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
  SIGNET_EVENT_NAME_LENGTH,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  signetEventSourceFromPublicDataProvider,
  type SignetMiscEvent,
} from "../src/index.ts";
import {
  notificationEventOf,
  respondBidirectionalEventOf,
  signatureRespondedEventOf,
} from "./signet-event-fixtures.ts";

/**
 * Narrow an indexed read into a decoded-event array. The `toHaveLength`
 * assertion at each call site proves the element is there; the index
 * signature does not.
 *
 * @param events - The decoded signet events.
 * @param index - Position to read.
 * @returns The event at that position.
 * @throws If no event sits at that index.
 */
function eventAt(events: readonly SignetMiscEvent[], index = 0): SignetMiscEvent {
  const event = events[index];
  if (event === undefined) {
    throw new Error(
      `expected a signet event at index ${String(index)}, got ${String(events.length)} events`,
    );
  }
  return event;
}

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// One notification registered by a caller at field 4, packed by the compiled
// circuit (the same packer client contracts call in-circuit).
const CALLER_ADDRESS_BYTES = bytes(32, 0xc1);
const NOTIFICATION = pureCircuits.constructSignBidirectionalEventNotificationV1(
  { bytes: CALLER_ADDRESS_BYTES },
  1n,
  [4n, 0n, 0n, 0n],
);

// The request id the notification and respond posts below declare, and synthetic signatures
// (the decoders decode, they do not verify). recoveryId 1 on RESPONSE so a
// decoder that dropped the byte cannot match a 0 default.
const REQUEST_ID = bytes(32, 0x2f);
const RESPONSE: SignatureRespondedEvent = {
  signature: {
    bigR: { x: bytes(32, 0xa0), y: bytes(32, 0xa1) },
    s: bytes(32, 0xa2),
    recoveryId: 1n,
  },
};
const RESPOND_BIDIRECTIONAL: RespondBidirectionalEvent = {
  signature: {
    bigR: { x: bytes(32, 0x5c), y: bytes(32, 0x5d) },
    s: bytes(32, 0x5e),
    recoveryId: 1n,
  },
};

describe("decodeSignetEventName", () => {
  it("strips the NUL padding the contract's pad(32, ...) adds", () => {
    expect(decodeSignetEventName(asciiPadded("SignatureRespondedEvent", 32))).toBe(
      SignetEventName.SignatureRespondedEvent,
    );
  });

  it("keeps an unpadded name verbatim", () => {
    expect(decodeSignetEventName(asciiPadded("x".repeat(32), 32))).toBe("x".repeat(32));
  });
});

describe("notification event payload (pack↔decode lockstep)", () => {
  it("decodes a circuit-packed notification back to its declared id and fields", () => {
    const event = notificationEventOf(REQUEST_ID, NOTIFICATION);
    const post = decodeSignBidirectionalEventNotificationPayload(event.payload);
    expect(post).toEqual({ requestId: REQUEST_ID, event: NOTIFICATION });
    expect(decodeSignBidirectionalNotification(post.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(CALLER_ADDRESS_BYTES),
      requestsPath: [4],
    });
  });

  it("fails closed decoding an unsupported notification version", () => {
    expect(() => decodeSignBidirectionalNotification({ ...NOTIFICATION, version: 2n })).toThrow(
      /version 2 is not supported/,
    );
  });

  it("rejects a payload too short to hold the record", () => {
    expect(() => decodeSignBidirectionalEventNotificationPayload(bytes(64, 1))).toThrow(
      /too short/,
    );
  });
});

describe("respond event payloads (encode↔decode round trip)", () => {
  it("round-trips a signature response with its declared request id", () => {
    expect(
      decodeSignatureRespondedEventPayload(signatureRespondedEventOf(REQUEST_ID, RESPONSE).payload),
    ).toEqual({ requestId: REQUEST_ID, event: RESPONSE });
  });

  it("round-trips a respond-bidirectional attestation with its declared request id", () => {
    expect(
      decodeRespondBidirectionalEventPayload(
        respondBidirectionalEventOf(REQUEST_ID, RESPOND_BIDIRECTIONAL).payload,
      ),
    ).toEqual({ requestId: REQUEST_ID, event: RESPOND_BIDIRECTIONAL });
  });

  it("rejects a payload too short to hold the packed record", () => {
    // 128 bytes end exactly where the recovery id byte should sit.
    expect(() => decodeSignatureRespondedEventPayload(bytes(128, 1))).toThrow(/too short/);
  });
});

// A simulator LogEvent for a misc emission of `name` ++ `payload`, its value
// trailing-zero-trimmed exactly as the state layer stores atoms.
const logEventOf = (name: string, payload: Uint8Array, address = "aa".repeat(32)): LogEvent => {
  const full = new Uint8Array(SIGNET_EVENT_NAME_LENGTH + SIGNET_EVENT_PAYLOAD_LENGTH);
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
      logEventOf(
        SignetEventName.SignatureRespondedEvent,
        signatureRespondedEventOf(REQUEST_ID, RESPONSE).payload,
      ),
    ]);
    expect(decoded).toHaveLength(1);
    expect(eventAt(decoded).name).toBe(SignetEventName.SignatureRespondedEvent);
    expect(eventAt(decoded).payload).toHaveLength(SIGNET_EVENT_PAYLOAD_LENGTH);
    expect(decodeSignatureRespondedEventPayload(eventAt(decoded).payload)).toEqual({
      requestId: REQUEST_ID,
      event: RESPONSE,
    });
  });

  it("filters by emitting contract address when one is given", () => {
    const event = logEventOf(
      SignetEventName.SignatureRespondedEvent,
      signatureRespondedEventOf(REQUEST_ID, RESPONSE).payload,
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

  it("throws on a misc event whose cell holds more than the one bytes atom", () => {
    const event = logEventOf(
      SignetEventName.SignatureRespondedEvent,
      signatureRespondedEventOf(REQUEST_ID, RESPONSE).payload,
    );
    if (event.data.tag !== "cell") throw new Error("logEventOf builds a cell");
    const twoAtoms: LogEvent = {
      ...event,
      data: {
        tag: "cell",
        content: {
          value: [...event.data.content.value, bytes(1, 0xff)],
          alignment: event.data.content.alignment,
        },
      },
    };
    expect(() => decodeSignetLogEvents([twoAtoms])).toThrow(/1 of 2 atoms unconsumed/);
  });
});

describe("signetEventSourceFromPublicDataProvider (indexer adapter)", () => {
  const SIGNET_ADDRESS = "signet-contract-address";

  it("queries Misc events and normalizes hex name/payload into signet events", async () => {
    const served = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
    // The indexer serves hex strings, the payload's trailing zeros trimmed
    // like any stored atom.
    let trimmed = served.payload.length;
    while (trimmed > 0 && served.payload[trimmed - 1] === 0) trimmed -= 1;
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: (filter, page) => {
        expect(filter).toEqual({
          contractAddress: SIGNET_ADDRESS,
          types: ["Misc"],
        });
        expect(page).toEqual({ limit: 100, offset: 0 });
        return Promise.resolve([
          {
            eventType: "Misc",
            name: bytesToHex(asciiPadded(served.name, SIGNET_EVENT_NAME_LENGTH)),
            payload: `0x${bytesToHex(served.payload.slice(0, trimmed))}`,
          },
        ]);
      },
    });

    const events = await source.querySignetEvents(SIGNET_ADDRESS);
    expect(events).toHaveLength(1);
    expect(eventAt(events).name).toBe(SignetEventName.SignatureRespondedEvent);
    expect(eventAt(events).payload).toHaveLength(SIGNET_EVENT_PAYLOAD_LENGTH);
    expect(decodeSignatureRespondedEventPayload(eventAt(events).payload)).toEqual({
      requestId: REQUEST_ID,
      event: RESPONSE,
    });
  });

  it("drops non-Misc events and Misc events missing name or payload", async () => {
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: () =>
        Promise.resolve([
          { eventType: "Paused" },
          { eventType: "Misc", name: bytesToHex(asciiPadded("x", 32)) },
        ]),
    });
    expect(await source.querySignetEvents(SIGNET_ADDRESS)).toHaveLength(0);
  });

  it("pages past the provider's page size: a 250-event history is read in full", async () => {
    // A provider serves at most `limit` events per call. An adapter that
    // stops at one page sees only the oldest 100 events of a busy signet and
    // starves every consumer of the rest.
    const served = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
    const history = Array.from({ length: 250 }, () => ({
      eventType: "Misc",
      name: bytesToHex(asciiPadded(served.name, SIGNET_EVENT_NAME_LENGTH)),
      payload: `0x${bytesToHex(served.payload)}`,
    }));
    const requestedOffsets: number[] = [];
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: (_filter, page) => {
        requestedOffsets.push(page.offset);
        return Promise.resolve(history.slice(page.offset, page.offset + page.limit));
      },
    });

    const events = await source.querySignetEvents(SIGNET_ADDRESS);
    expect(events).toHaveLength(250);
    expect(requestedOffsets).toEqual([0, 100, 200]);
  });
});
