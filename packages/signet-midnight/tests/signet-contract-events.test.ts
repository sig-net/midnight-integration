// Unit tests for the signet contract event decoders: payload decode twins,
// the simulator-log bridge, and the indexer adapter, over fixtures
// built by the test-local encode twins (signet-event-fixtures.ts). The
// notification fixtures are packed by the REAL compiled circuit, pinning
// that pack↔decode lockstep in-process; the event-envelope lockstep against
// the real contract emits is pinned by the signet-contract package's
// simulator tests.

import { createServer, type Server } from "node:http";

import { CompactTypeBytes, type LogEvent } from "@midnight-ntwrk/compact-runtime";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  asciiPadded,
  bytesToHex,
  type DecodedSignetEvent,
  decodeRespondBidirectionalEventPayload,
  decodeSignatureRespondedEventPayload,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetEvent,
  decodeSignetEventName,
  decodeSignetEventNamed,
  decodeSignetLogEvents,
  type IndexedSignetMiscEvent,
  OutputKind,
  pureCircuits,
  requestIdHex,
  type RespondBidirectionalEvent,
  type SignatureRespondedEvent,
  type SignBidirectionalNotification,
  SIGNET_EVENT_NAME_LENGTH,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  signetEventRecordsOf,
  signetEventSourceFromIndexer,
  type SignetMiscEvent,
  tryDecodeSignetEvent,
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
  requestId: REQUEST_ID,
  signature: {
    bigR: { x: bytes(32, 0xa0), y: bytes(32, 0xa1) },
    s: bytes(32, 0xa2),
    recoveryId: 1n,
  },
};
const RESPOND_BIDIRECTIONAL: RespondBidirectionalEvent = {
  requestId: REQUEST_ID,
  blockHeight: 0x0102030405060708n,
  outputKind: OutputKind.unviable,
  serializedOutputLength: 33n,
  digest: bytes(32, 0x60),
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
      source: event,
    });
  });

  it("keeps the indexer cursor of the event it was given", () => {
    const indexed: IndexedSignetMiscEvent = {
      ...signatureRespondedEventOf(REQUEST_ID, RESPONSE),
      id: 7,
      maxId: 9,
      transactionId: 42,
      transactionHash: "e5".repeat(32),
      blockHeight: 382086,
      blockHash: "c0".repeat(32),
      blockTimestamp: new Date(1788932760000),
    };
    expect(decodeSignetEvent(indexed)?.source).toBe(indexed);
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
      source: event,
    });
  });

  it("skips an undecodable event of another kind without touching its payload", () => {
    const garbage = notificationEventOf(REQUEST_ID, { ...NOTIFICATION, version: 2n });
    expect(
      decodeSignetEventNamed(garbage, SignetEventName.SignatureRespondedEvent),
    ).toBeUndefined();
  });
});

describe("DecodedSignetEvent (type-level promises)", () => {
  it("narrows record when narrowed on name", () => {
    const decoded = decodeSignetEvent(signatureRespondedEventOf(REQUEST_ID, RESPONSE));
    if (decoded?.name === SignetEventName.SignBidirectionalEvent) {
      expectTypeOf(decoded.record).toEqualTypeOf<SignBidirectionalNotification>();
    }
    if (decoded?.name === SignetEventName.SignatureRespondedEvent) {
      expectTypeOf(decoded.record).toEqualTypeOf<SignatureRespondedEvent>();
    }
    if (decoded?.name === SignetEventName.RespondBidirectionalEvent) {
      expectTypeOf(decoded.record).toEqualTypeOf<RespondBidirectionalEvent>();
    }
  });

  it("types a named decode as that one kind", () => {
    const event = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
    const decoded = decodeSignetEventNamed(event, SignetEventName.SignatureRespondedEvent);
    expectTypeOf(decoded?.record).toEqualTypeOf<SignatureRespondedEvent | undefined>();
  });

  it("keeps the indexed shape on the source event", () => {
    expectTypeOf<
      DecodedSignetEvent<IndexedSignetMiscEvent>["source"]
    >().toEqualTypeOf<IndexedSignetMiscEvent>();
    expectTypeOf<DecodedSignetEvent["source"]>().toEqualTypeOf<SignetMiscEvent>();
  });

  it("pins the notification version to the literal of its one layout", () => {
    expectTypeOf<SignBidirectionalNotification["version"]>().toEqualTypeOf<1>();
  });
});

describe("tryDecodeSignetEvent (decode without the throw)", () => {
  it("wraps a decoded event", () => {
    const event = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
    expect(tryDecodeSignetEvent(event)).toEqual({ ok: true, event: decodeSignetEvent(event) });
  });

  it("reports an undecodable payload beside its event and the decoder's reason", () => {
    const event = notificationEventOf(REQUEST_ID, { ...NOTIFICATION, version: 2n });
    const result = tryDecodeSignetEvent(event);
    if (result?.ok !== false) {
      throw new Error("expected the decode to fail");
    }
    expect(result.source).toBe(event);
    expect(result.reason).toMatch(/version 2 is not supported/);
  });

  it("returns undefined for a name that is not a signet event name", () => {
    expect(tryDecodeSignetEvent({ name: "SomethingElse", payload: bytes(256, 0) })).toBeUndefined();
  });
});

describe("signetEventRecordsOf (routing over events in hand)", () => {
  const OTHER_REQUEST_ID = bytes(32, 0x30);
  const IN_HAND: DecodedSignetEvent[] = [
    notificationEventOf(REQUEST_ID, NOTIFICATION),
    signatureRespondedEventOf(OTHER_REQUEST_ID, RESPONSE),
    signatureRespondedEventOf(REQUEST_ID, RESPONSE),
    respondBidirectionalEventOf(REQUEST_ID, RESPOND_BIDIRECTIONAL),
  ].flatMap((event) => decodeSignetEvent(event) ?? []);

  it("keeps the records of the asked kind declared under the asked request id", () => {
    expect(
      signetEventRecordsOf(
        IN_HAND,
        SignetEventName.SignatureRespondedEvent,
        requestIdHex(REQUEST_ID),
      ),
    ).toEqual([RESPONSE]);
  });

  it("returns nothing for a request id no event declares", () => {
    expect(
      signetEventRecordsOf(
        IN_HAND,
        SignetEventName.RespondBidirectionalEvent,
        requestIdHex(OTHER_REQUEST_ID),
      ),
    ).toEqual([]);
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

/** One `contractEvents` row as the indexer's GraphQL endpoint serves it. */
interface ServedRow {
  __typename: string;
  id: number;
  maxId: number;
  transactionId: number;
  transaction?: { hash: string; block: { height: number; hash: string; timestamp: number } };
  name?: string;
  payload?: string;
}

/** What the indexer stand-in answered for one request: the variables the adapter sent. */
interface ServedQuery {
  filter: { contractAddress: string; types: string[] };
  limit: number;
  offset: number;
}

let indexer: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (indexer === undefined) {
        resolve();
        return;
      }
      indexer.close(() => {
        resolve();
      });
      indexer = undefined;
    }),
);

/**
 * Start an indexer stand-in: a GraphQL endpoint answering every POST with
 * `answer(variables)` as JSON, recording the variables it was sent.
 *
 * @param answer - The response body for a request's variables.
 * @param queries - Receives each request's variables, in order.
 * @param status - The HTTP status to answer with.
 * @returns The endpoint URL.
 */
async function serveIndexer(
  answer: (variables: ServedQuery) => object,
  queries: ServedQuery[] = [],
  status = 200,
): Promise<string> {
  const started = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const posted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        variables: ServedQuery;
      };
      queries.push(posted.variables);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer(posted.variables)));
    });
  });
  indexer = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  const address = started.address();
  if (address === null || typeof address === "string") {
    throw new Error("the indexer stand-in has no TCP address");
  }
  return `http://127.0.0.1:${String(address.port)}/api/v4/graphql`;
}

/**
 * Serve `history` the way the indexer pages it: the window the request's
 * `limit` and `offset` name.
 *
 * @param history - Every row of the contract's history, oldest first.
 * @param queries - Receives each request's variables, in order.
 * @returns The endpoint URL.
 */
function serveHistory(history: ServedRow[], queries: ServedQuery[] = []): Promise<string> {
  return serveIndexer(
    ({ limit, offset }) => ({ data: { contractEvents: history.slice(offset, offset + limit) } }),
    queries,
  );
}

describe("signetEventSourceFromIndexer", () => {
  const SIGNET_ADDRESS = "ab".repeat(32);
  const served = signatureRespondedEventOf(REQUEST_ID, RESPONSE);
  const SERVED_NAME = bytesToHex(asciiPadded(served.name, SIGNET_EVENT_NAME_LENGTH));
  // The indexer serves the payload with its trailing zeros trimmed, like any stored atom.
  let trimmed = served.payload.length;
  while (trimmed > 0 && served.payload[trimmed - 1] === 0) trimmed -= 1;
  const SERVED_PAYLOAD = bytesToHex(served.payload.slice(0, trimmed));
  const MISC_ROW: ServedRow = {
    __typename: "MiscContractEvent",
    id: 7,
    maxId: 9,
    transactionId: 42,
    transaction: {
      hash: "e5".repeat(32),
      block: { height: 382086, hash: "c0".repeat(32), timestamp: 1788932760000 },
    },
    name: SERVED_NAME,
    payload: SERVED_PAYLOAD,
  };

  /**
   * A history of `count` Misc rows with ids 1 to `count`, every row
   * reporting `maxId` as the indexer tip.
   *
   * @param count - Number of rows.
   * @param maxId - The tip every row reports.
   * @returns The rows, oldest first.
   */
  function historyOf(count: number, maxId: number): ServedRow[] {
    return Array.from({ length: count }, (_, index) => ({
      ...MISC_ROW,
      id: index + 1,
      maxId,
      transactionId: index + 1,
    }));
  }

  it("queries the contract's Misc events and streams them with where they were emitted", async () => {
    const queries: ServedQuery[] = [];
    const queryUrl = await serveHistory([MISC_ROW], queries);

    const events = await collect(
      signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS),
    );

    expect(queries).toEqual([
      { filter: { contractAddress: SIGNET_ADDRESS, types: ["MISC"] }, limit: 100, offset: 0 },
    ]);
    expect(events).toEqual([
      {
        name: SignetEventName.SignatureRespondedEvent,
        payload: served.payload,
        id: 7,
        maxId: 9,
        transactionId: 42,
        transactionHash: "e5".repeat(32),
        blockHeight: 382086,
        blockHash: "c0".repeat(32),
        blockTimestamp: new Date(1788932760000),
      },
    ]);
    expect(decodeSignatureRespondedEventPayload(eventAt(events).payload)).toEqual({
      requestId: REQUEST_ID,
      event: RESPONSE,
    });
  });

  it("drops rows that are not Misc events", async () => {
    const queryUrl = await serveHistory([{ ...MISC_ROW, __typename: "PausedEvent" }, MISC_ROW]);
    const events = await collect(
      signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS),
    );
    expect(events.map((event) => event.id)).toEqual([7]);
  });

  it.each<{ label: string; row: ServedRow; expected: RegExp }>([
    {
      label: "a Misc row without a name",
      row: { ...MISC_ROW, name: undefined },
      expected: /malformed Misc contract event/,
    },
    {
      label: "a Misc row without its transaction",
      row: { ...MISC_ROW, transaction: undefined },
      expected: /malformed Misc contract event/,
    },
    {
      label: "a payload that is not a hex byte string",
      row: { ...MISC_ROW, payload: "zz" },
      expected: /not a hex byte string/,
    },
  ])("throws on $label", async ({ row, expected }) => {
    const queryUrl = await serveHistory([row]);
    await expect(
      collect(signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS)),
    ).rejects.toThrow(expected);
  });

  it.each<{ label: string; contractAddress: string }>([
    { label: "an address that is not hex", contractAddress: "zz".repeat(32) },
    { label: "an address shorter than 32 bytes", contractAddress: "ab".repeat(31) },
  ])("fails on $label before sending any request", async ({ contractAddress }) => {
    const queries: ServedQuery[] = [];
    const queryUrl = await serveHistory([MISC_ROW], queries);
    await expect(
      collect(signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(contractAddress)),
    ).rejects.toThrow(/not a 32-byte contract address in hex/);
    expect(queries).toEqual([]);
  });

  it("sends a 0x prefixed, upper case address as the bare lower case hex the indexer expects", async () => {
    const queries: ServedQuery[] = [];
    const queryUrl = await serveHistory([MISC_ROW], queries);
    await collect(
      signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(
        `0x${SIGNET_ADDRESS.toUpperCase()}`,
      ),
    );
    expect(queries.map((query) => query.filter.contractAddress)).toEqual([SIGNET_ADDRESS]);
  });

  it("throws with the indexer's words when it rejects the query", async () => {
    const queryUrl = await serveIndexer(() => ({
      data: null,
      errors: [{ message: "invalid contract event filter: unknown field prefix" }],
    }));
    await expect(
      collect(signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS)),
    ).rejects.toThrow(/indexer rejected the contract events query: invalid contract event filter/);
  });

  it("throws on an HTTP status other than 200", async () => {
    const queryUrl = await serveIndexer(() => ({ message: "upstream down" }), [], 502);
    await expect(
      collect(signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS)),
    ).rejects.toThrow(/indexer answered HTTP 502/);
  });

  it("throws when the answer carries no page", async () => {
    const queryUrl = await serveIndexer(() => ({ data: {} }));
    await expect(
      collect(signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS)),
    ).rejects.toThrow(/without a page/);
  });

  it("pages past the page size: a 250-event history is read in full", async () => {
    // The indexer serves at most `limit` events per request. An adapter that
    // stops at one page sees only the oldest 100 events of a busy signet and
    // starves every consumer of the rest.
    const history = historyOf(250, 250);
    const queries: ServedQuery[] = [];
    const queryUrl = await serveHistory(history, queries);

    const events = await collect(
      signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS),
    );
    expect(events.map((event) => event.id)).toEqual(history.map((row) => row.id));
    expect(queries.map((query) => query.offset)).toEqual([0, 100, 200]);
  });

  it("yields a page's events before requesting the next page", async () => {
    const queries: ServedQuery[] = [];
    const queryUrl = await serveHistory(historyOf(150, 150), queries);

    const stream = signetEventSourceFromIndexer({ queryUrl })
      .streamSignetEvents(SIGNET_ADDRESS)
      [Symbol.asyncIterator]();
    for (let pulled = 0; pulled < 100; pulled += 1) {
      expect((await stream.next()).done).toBe(false);
    }
    expect(queries.map((query) => query.offset)).toEqual([0]);
    expect((await stream.next()).done).toBe(false);
    expect(queries.map((query) => query.offset)).toEqual([0, 100]);
  });

  it("ends at the tip pinned by the first page, dropping events appended since", async () => {
    // Page one reports a tip of 120. Rows past it (appended while paging)
    // would extend the walk indefinitely on a busy contract.
    const history = [...historyOf(100, 120), ...historyOf(150, 150).slice(100)];
    const queries: ServedQuery[] = [];
    const queryUrl = await serveHistory(history, queries);

    const events = await collect(
      signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(SIGNET_ADDRESS),
    );
    expect(events).toHaveLength(120);
    expect(eventAt(events, 119).id).toBe(120);
    expect(queries.map((query) => query.offset)).toEqual([0, 100]);
  });

  it("stops requesting pages when the consumer leaves the loop", async () => {
    const queries: ServedQuery[] = [];
    const queryUrl = await serveHistory(historyOf(250, 250), queries);

    let seen = 0;
    for await (const event of signetEventSourceFromIndexer({ queryUrl }).streamSignetEvents(
      SIGNET_ADDRESS,
    )) {
      seen += 1;
      if (event.id === 100) break;
    }
    expect(seen).toBe(100);
    expect(queries.map((query) => query.offset)).toEqual([0]);
  });
});
