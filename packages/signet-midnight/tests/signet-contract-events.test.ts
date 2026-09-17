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
  type ContractEventRow,
  decodeRespondBidirectionalEventPayload,
  decodeSignatureRespondedEventPayload,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetEvent,
  decodeSignetEventName,
  decodeSignetEventNamed,
  decodeSignetLogEvents,
  type IndexedSignetMiscEvent,
  pureCircuits,
  requestIdHex,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
  SIGNET_EVENT_NAME_LENGTH,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  signetEventSourceFromPublicDataProvider,
  type SignetMiscEvent,
  signetMiscEventFromContractEventRow,
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
function eventAt<TEvent extends SignetMiscEvent>(events: readonly TEvent[], index = 0): TEvent {
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

describe("decodeSignetEvent (dispatch by name)", () => {
  it.each<{ label: string; event: SignetMiscEvent; record: object }>([
    {
      label: "a notification, decoded through to its pointer",
      event: notificationEventOf(REQUEST_ID, NOTIFICATION),
      record: { version: 1, callerAddress: bytesToHex(CALLER_ADDRESS_BYTES), requestsPath: [4] },
    },
    {
      label: "a signature response",
      event: signatureRespondedEventOf(REQUEST_ID, RESPONSE),
      record: RESPONSE,
    },
    {
      label: "a respond-bidirectional attestation",
      event: respondBidirectionalEventOf(REQUEST_ID, RESPOND_BIDIRECTIONAL),
      record: RESPOND_BIDIRECTIONAL,
    },
  ])("decodes $label under its name with the request id in canonical form", ({ event, record }) => {
    expect(decodeSignetEvent(event)).toEqual({
      name: event.name,
      requestId: requestIdHex(REQUEST_ID),
      record,
      raw: event,
    });
  });

  it("keeps the indexer cursor of the event it was given", () => {
    const indexed: IndexedSignetMiscEvent = {
      ...signatureRespondedEventOf(REQUEST_ID, RESPONSE),
      id: 7,
      maxId: 9,
      transactionId: 42,
    };
    expect(decodeSignetEvent(indexed)?.raw).toBe(indexed);
  });

  it("returns undefined for a name that is not a signet event name", () => {
    expect(decodeSignetEvent({ name: "SomethingElse", payload: bytes(256, 0) })).toBeUndefined();
  });

  it("throws on a recognised event whose payload does not decode", () => {
    const event = notificationEventOf(REQUEST_ID, { ...NOTIFICATION, version: 2n });
    expect(() => decodeSignetEvent(event)).toThrow(/version 2 is not supported/);
  });
});

describe("decodeSignetEventNamed (one kind only)", () => {
  it("decodes an event of the asked kind", () => {
    const event = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
    expect(decodeSignetEventNamed(event, SignetEventName.SignatureRespondedEvent)).toEqual({
      name: SignetEventName.SignatureRespondedEvent,
      requestId: requestIdHex(REQUEST_ID),
      record: RESPONSE,
      raw: event,
    });
  });

  it("skips an undecodable event of another kind without touching its payload", () => {
    const garbage = notificationEventOf(REQUEST_ID, { ...NOTIFICATION, version: 2n });
    expect(
      decodeSignetEventNamed(garbage, SignetEventName.SignatureRespondedEvent),
    ).toBeUndefined();
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

/**
 * Drain an async iterable into an array, the way a consumer that wants the
 * whole history reads a stream.
 *
 * @param stream - The stream to drain.
 * @returns Every item, in stream order.
 */
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("signetMiscEventFromContractEventRow", () => {
  const served = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
  // The indexer serves hex strings, the payload's trailing zeros trimmed
  // like any stored atom.
  let trimmed = served.payload.length;
  while (trimmed > 0 && served.payload[trimmed - 1] === 0) trimmed -= 1;
  const MISC_ROW: ContractEventRow = {
    eventType: "Misc",
    id: 7,
    maxId: 9,
    transactionId: 42,
    name: bytesToHex(asciiPadded(served.name, SIGNET_EVENT_NAME_LENGTH)),
    payload: `0x${bytesToHex(served.payload.slice(0, trimmed))}`,
  };

  it("normalises a Misc row into a signet event carrying the indexer cursor", () => {
    const event = signetMiscEventFromContractEventRow(MISC_ROW);
    if (event === undefined) throw new Error("expected a Misc row to yield an event");
    expect(event).toMatchObject({
      name: SignetEventName.SignatureRespondedEvent,
      id: 7,
      maxId: 9,
      transactionId: 42,
    });
    expect(event.payload).toHaveLength(SIGNET_EVENT_PAYLOAD_LENGTH);
    expect(decodeSignatureRespondedEventPayload(event.payload)).toEqual({
      requestId: REQUEST_ID,
      event: RESPONSE,
    });
  });

  it.each<{ label: string; row: ContractEventRow }>([
    { label: "a non-Misc row", row: { ...MISC_ROW, eventType: "Paused" } },
    { label: "a Misc row without a name", row: { ...MISC_ROW, name: undefined } },
    { label: "a Misc row without a payload", row: { ...MISC_ROW, payload: undefined } },
  ])("yields no event for $label", ({ row }) => {
    expect(signetMiscEventFromContractEventRow(row)).toBeUndefined();
  });

  it("throws on a payload that is not a hex byte string", () => {
    expect(() => signetMiscEventFromContractEventRow({ ...MISC_ROW, payload: "zz" })).toThrow(
      /not a hex byte string/,
    );
  });
});

describe("signetEventSourceFromPublicDataProvider (indexer adapter)", () => {
  const SIGNET_ADDRESS = "signet-contract-address";
  const served = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
  const SERVED_NAME = bytesToHex(asciiPadded(served.name, SIGNET_EVENT_NAME_LENGTH));
  const SERVED_PAYLOAD = `0x${bytesToHex(served.payload)}`;

  /**
   * A history of `count` Misc rows with ids 1 to `count`, every row
   * reporting `maxId` as the indexer tip.
   *
   * @param count - Number of rows.
   * @param maxId - The tip every row reports.
   * @returns The rows, oldest first.
   */
  function historyOf(count: number, maxId: number): ContractEventRow[] {
    return Array.from({ length: count }, (_, index) => ({
      eventType: "Misc",
      id: index + 1,
      maxId,
      transactionId: index + 1,
      name: SERVED_NAME,
      payload: SERVED_PAYLOAD,
    }));
  }

  it("queries Misc events and streams them as signet events", async () => {
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: (filter, page) => {
        expect(filter).toEqual({
          contractAddress: SIGNET_ADDRESS,
          types: ["Misc"],
        });
        expect(page).toEqual({ limit: 100, offset: 0 });
        return Promise.resolve(historyOf(1, 1));
      },
    });

    const events = await collect(source.streamSignetEvents(SIGNET_ADDRESS));
    expect(events).toHaveLength(1);
    expect(eventAt(events)).toMatchObject({
      name: SignetEventName.SignatureRespondedEvent,
      id: 1,
      maxId: 1,
      transactionId: 1,
    });
    expect(decodeSignatureRespondedEventPayload(eventAt(events).payload)).toEqual({
      requestId: REQUEST_ID,
      event: RESPONSE,
    });
  });

  it("drops non-Misc events and Misc events missing name or payload", async () => {
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: () =>
        Promise.resolve([
          { eventType: "Paused", id: 1, maxId: 2, transactionId: 1 },
          { eventType: "Misc", id: 2, maxId: 2, transactionId: 2, name: SERVED_NAME },
        ]),
    });
    expect(await collect(source.streamSignetEvents(SIGNET_ADDRESS))).toHaveLength(0);
  });

  it("pages past the provider's page size: a 250-event history is read in full", async () => {
    // A provider serves at most `limit` events per call. An adapter that
    // stops at one page sees only the oldest 100 events of a busy signet and
    // starves every consumer of the rest.
    const history = historyOf(250, 250);
    const requestedOffsets: number[] = [];
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: (_filter, page) => {
        requestedOffsets.push(page.offset);
        return Promise.resolve(history.slice(page.offset, page.offset + page.limit));
      },
    });

    const events = await collect(source.streamSignetEvents(SIGNET_ADDRESS));
    expect(events).toHaveLength(250);
    expect(events.map((event) => event.id)).toEqual(history.map((row) => row.id));
    expect(requestedOffsets).toEqual([0, 100, 200]);
  });

  it("yields a page's events before requesting the next page", async () => {
    const history = historyOf(150, 150);
    const requestedOffsets: number[] = [];
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: (_filter, page) => {
        requestedOffsets.push(page.offset);
        return Promise.resolve(history.slice(page.offset, page.offset + page.limit));
      },
    });

    const stream = source.streamSignetEvents(SIGNET_ADDRESS)[Symbol.asyncIterator]();
    for (let pulled = 0; pulled < 100; pulled += 1) {
      expect((await stream.next()).done).toBe(false);
    }
    expect(requestedOffsets).toEqual([0]);
    expect((await stream.next()).done).toBe(false);
    expect(requestedOffsets).toEqual([0, 100]);
  });

  it("ends at the tip pinned by the first page, dropping events appended since", async () => {
    // Page one reports a tip of 120. Rows past it (appended while paging)
    // would extend the walk indefinitely on a busy contract.
    const history = [...historyOf(100, 120), ...historyOf(150, 150).slice(100)];
    const requestedOffsets: number[] = [];
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: (_filter, page) => {
        requestedOffsets.push(page.offset);
        return Promise.resolve(history.slice(page.offset, page.offset + page.limit));
      },
    });

    const events = await collect(source.streamSignetEvents(SIGNET_ADDRESS));
    expect(events).toHaveLength(120);
    expect(eventAt(events, 119).id).toBe(120);
    expect(requestedOffsets).toEqual([0, 100]);
  });

  it("stops requesting pages when the consumer leaves the loop", async () => {
    const history = historyOf(250, 250);
    const requestedOffsets: number[] = [];
    const source = signetEventSourceFromPublicDataProvider({
      queryContractEvents: (_filter, page) => {
        requestedOffsets.push(page.offset);
        return Promise.resolve(history.slice(page.offset, page.offset + page.limit));
      },
    });

    let seen = 0;
    for await (const event of source.streamSignetEvents(SIGNET_ADDRESS)) {
      seen += 1;
      if (event.id === 100) break;
    }
    expect(seen).toBe(100);
    expect(requestedOffsets).toEqual([0]);
  });
});
