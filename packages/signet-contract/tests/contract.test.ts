// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime (no network, no proving). Every circuit
// emits one named Misc event with a packed payload, nothing is verified in
// circuit, and verification is deliberately the reader's job. The tests pin
// exactly that: each circuit's emit lands as one event, garbage lands too,
// repeats append, and the payloads decode back through the @sig-net/midnight
// event decoders. That
// decode is the LOCKSTEP CHECK between the contract's emit literals and the
// TS byte-plumbing twins: it runs against REAL emitted events, so an offset
// or field-order drift on either side fails here.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  bytesToHex,
  decodeRespondBidirectionalEventPayload,
  decodeSignatureRespondedEventPayload,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetLogEvents,
  SignetEventName,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  pureCircuits as signetCircuits,
  type SignatureRespondedEvent,
  type RespondBidirectionalEvent,
  type SignetMiscEvent,
} from "@sig-net/midnight";

import {
  Contract,
  createSignetContractPrivateState,
  witnesses,
  type SignetContractPrivateState,
} from "../src/index.ts";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

// Request ids the posts below answer, and signature response records.
// SYNTHETIC signatures, deliberately not verifiable: the contract must
// emit them anyway (verification is the reader's job). SIG_1 and SIG_2
// differ in every leaf INCLUDING recoveryId: a decoder that dropped that
// field would still match a single 0-valued fixture.
const REQUEST_A = bytes(32, 0xaa);
const REQUEST_B = bytes(32, 0xbb);
const SIG_1: SignatureRespondedEvent = {
  signature: { bigR: { x: bytes(32, 0x01), y: bytes(32, 0x02) }, s: bytes(32, 0x03), recoveryId: 0n },
};
const SIG_2: SignatureRespondedEvent = {
  signature: { bigR: { x: bytes(32, 0x04), y: bytes(32, 0x05) }, s: bytes(32, 0x06), recoveryId: 1n },
};

// Respond-bidirectional records: SYNTHETIC signatures, deliberately not
// verifiable. The contract must emit them anyway (verification is the
// reader's job).
const RESPOND_1: RespondBidirectionalEvent = {
  signature: { bigR: { x: bytes(32, 0x07), y: bytes(32, 0x08) }, s: bytes(32, 0x09), recoveryId: 0n },
};
const RESPOND_2: RespondBidirectionalEvent = {
  signature: { bigR: { x: bytes(32, 0x0a), y: bytes(32, 0x0b) }, s: bytes(32, 0x0c), recoveryId: 1n },
};

// A caller contract address as the packer consumes it (raw 32 bytes). The
// registering client passes kernel.self(), but here a fixed fixture suffices.
const NOTIFYING_CALLER = { bytes: bytes(32, 0xc1) };

// ---- Harness ----

const deployContract = async (circuitId: string) => {
  const contract = new Contract<SignetContractPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext(createSignetContractPrivateState(), CPK),
    );
  const contractAddress = sampleContractAddress();
  const ctx = createCircuitContext(
    circuitId,
    contractAddress,
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx, contractAddress };
};

/** All bytes of `payload` from `offset` on must be the emit literal's zero fill. */
const expectZeroPadding = (payload: Uint8Array, offset: number) => {
  expect(payload).toHaveLength(SIGNET_EVENT_PAYLOAD_LENGTH);
  expect(payload.slice(offset)).toEqual(
    new Uint8Array(SIGNET_EVENT_PAYLOAD_LENGTH - offset),
  );
};

// ---- Tests ----

describe("signBidirectional", () => {
  // These callers are flat, so a field number is a depth-1 path [field].
  const notification = (requestsField: bigint) =>
    signetCircuits.constructSignBidirectionalEventNotificationV1(
      NOTIFYING_CALLER,
      1n,
      [requestsField, 0n, 0n, 0n],
    );

  it("emits the notification as a SignBidirectionalEvent event (decode lockstep)", async () => {
    const { contract, ctx, contractAddress } = await deployContract(
      "signBidirectional",
    );

    const { result, context } = await contract.circuits.signBidirectional(
      ctx,
      REQUEST_A,
      notification(4n),
    );
    expect(result).toEqual([]);

    // The one emitted event, tagged with THIS contract's address.
    const events = decodeSignetLogEvents(context.events, contractAddress);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.name).toBe(SignetEventName.SignBidirectionalEvent);

    // Emit literal: version (1) ++ notification payload (128) ++ zeros (127).
    const record = decodeSignBidirectionalEventNotificationPayload(event.payload);
    expect(record).toEqual(notification(4n));
    expectZeroPadding(event.payload, 129);

    // The packed V1 payload decodes back to the caller pointer.
    expect(decodeSignBidirectionalNotification(record)).toEqual({
      version: 1,
      callerAddress: bytesToHex(NOTIFYING_CALLER.bytes),
      requestsPath: [4],
    });
  });

  it("emits a repeat notify as its own event, nothing replaced", async () => {
    const { contract, ctx, contractAddress } = await deployContract(
      "signBidirectional",
    );

    const first = await contract.circuits.signBidirectional(
      ctx,
      REQUEST_A,
      notification(4n),
    );
    const second = await contract.circuits.signBidirectional(
      first.context,
      REQUEST_A,
      notification(7n), // different index field: both emits must survive
    );

    const events = decodeSignetLogEvents(second.context.events, contractAddress);
    expect(events).toHaveLength(2);
    expect(
      events.map((event) =>
        decodeSignBidirectionalNotification(
          decodeSignBidirectionalEventNotificationPayload(event.payload),
        ).requestsPath,
      ),
    ).toEqual([[4], [7]]);
  });

  it("rejects a notification whose version is not 1, emitting nothing", async () => {
    const { contract, ctx } = await deployContract("signBidirectional");
    await expect(
      contract.circuits.signBidirectional(ctx, REQUEST_A, {
        ...notification(4n),
        version: 2n,
      }),
    ).rejects.toThrow(/only version 1 notification supported/);
    expect(ctx.events).toHaveLength(0);
  });
});

/** One posted (requestId, signature) pair, applied in row order. */
interface Post {
  requestId: Uint8Array;
  signature: SignatureRespondedEvent;
}

/**
 * One row of the post table: a post sequence → the exact expected event log.
 * The emitted events carry the signature ALONE (no request id: a client
 * matches a post to its request by verifying the signature), so the expected
 * log is the ordered signature list.
 */
interface PostCase {
  /** Test name, completing the sentence "emits <name>". */
  name: string;
  /** Posts applied in order, each through respond. */
  posts: Post[];
  /** The FULL expected event log, in emission order. */
  expectedEvents: SignatureRespondedEvent[];
}

const POST_CASES: PostCase[] = [
  {
    name: "a single post as a single event",
    posts: [{ requestId: REQUEST_A, signature: SIG_1 }],
    expectedEvents: [SIG_1],
  },
  {
    name: "a second post for the same request APPENDED, the first untouched",
    posts: [
      { requestId: REQUEST_A, signature: SIG_1 },
      { requestId: REQUEST_A, signature: SIG_2 },
    ],
    expectedEvents: [SIG_1, SIG_2],
  },
  {
    name: "an identical re-post as its own event (no dedup, no error)",
    posts: [
      { requestId: REQUEST_A, signature: SIG_1 },
      { requestId: REQUEST_A, signature: SIG_1 },
    ],
    expectedEvents: [SIG_1, SIG_1],
  },
  {
    name: "interleaved posts for different requests in emission order",
    posts: [
      { requestId: REQUEST_A, signature: SIG_1 },
      { requestId: REQUEST_B, signature: SIG_2 },
      { requestId: REQUEST_A, signature: SIG_2 },
    ],
    expectedEvents: [SIG_1, SIG_2, SIG_2],
  },
];

describe("respond", () => {
  it.each(POST_CASES)(
    "emits $name",
    async ({ posts, expectedEvents }) => {
      const { contract, ctx, contractAddress } = await deployContract("respond");

      let finalCtx = ctx;
      for (const { requestId, signature } of posts) {
        finalCtx = (
          await contract.circuits.respond(finalCtx, requestId, signature)
        ).context;
      }

      // The event log holds EXACTLY the posts, in order, each decoding back
      // to the signature it carried (the emit↔decode lockstep, on REAL
      // emitted events).
      const events = decodeSignetLogEvents(finalCtx.events, contractAddress);
      expect(events.map((event) => event.name)).toEqual(
        expectedEvents.map(() => SignetEventName.SignatureRespondedEvent),
      );
      expect(
        events.map((event) => decodeSignatureRespondedEventPayload(event.payload)),
      ).toEqual(expectedEvents);
    },
  );

  it("packs the emit literal as bigR.x ++ bigR.y ++ s ++ recoveryId ++ zeros", async () => {
    const { contract, ctx, contractAddress } = await deployContract("respond");
    const { context } = await contract.circuits.respond(ctx, REQUEST_A, SIG_2);

    const [event] = decodeSignetLogEvents(context.events, contractAddress);
    expect(event.payload.slice(0, 32)).toEqual(SIG_2.signature.bigR.x);
    expect(event.payload.slice(32, 64)).toEqual(SIG_2.signature.bigR.y);
    expect(event.payload.slice(64, 96)).toEqual(SIG_2.signature.s);
    expect(event.payload[96]).toBe(1); // SIG_2's recoveryId
    expectZeroPadding(event.payload, 97);
  });
});

describe("respondBidirectional", () => {
  it("emits a post as a RespondBidirectionalEvent event, UNVERIFIED by design", async () => {
    const { contract, ctx, contractAddress } = await deployContract(
      "respondBidirectional",
    );

    const { context } = await contract.circuits.respondBidirectional(
      ctx,
      REQUEST_A,
      RESPOND_1,
    );

    const events = decodeSignetLogEvents(context.events, contractAddress);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe(SignetEventName.RespondBidirectionalEvent);
    // The synthetic (unverifiable) signature landed verbatim: the contract
    // emits, the reader verifies.
    expect(decodeRespondBidirectionalEventPayload(events[0].payload)).toEqual(
      RESPOND_1,
    );
    expectZeroPadding(events[0].payload, 97);
  });

  it("emits a second post for the same request as its own event, nothing replaced", async () => {
    const { contract, ctx, contractAddress } = await deployContract(
      "respondBidirectional",
    );

    const first = await contract.circuits.respondBidirectional(
      ctx,
      REQUEST_A,
      RESPOND_1,
    );
    const second = await contract.circuits.respondBidirectional(
      first.context,
      REQUEST_A,
      RESPOND_2,
    );

    const events = decodeSignetLogEvents(second.context.events, contractAddress);
    expect(
      events.map((event) => decodeRespondBidirectionalEventPayload(event.payload)),
    ).toEqual([RESPOND_1, RESPOND_2]);
  });

  it("keeps the three event kinds apart by name in one shared log", async () => {
    // One circuit of each kind through the same threaded context: the log
    // holds three differently-named events a reader can partition.
    const { contract, ctx, contractAddress } = await deployContract("respond");
    const afterRespond = await contract.circuits.respond(ctx, REQUEST_A, SIG_1);
    const afterNotify = await contract.circuits.signBidirectional(
      afterRespond.context,
      REQUEST_A,
      signetCircuits.constructSignBidirectionalEventNotificationV1(
        NOTIFYING_CALLER,
        1n,
        [4n, 0n, 0n, 0n],
      ),
    );
    const { context } = await contract.circuits.respondBidirectional(
      afterNotify.context,
      REQUEST_A,
      RESPOND_1,
    );

    const names = decodeSignetLogEvents(context.events, contractAddress).map(
      (event: SignetMiscEvent) => event.name,
    );
    expect(names).toEqual([
      SignetEventName.SignatureRespondedEvent,
      SignetEventName.SignBidirectionalEvent,
      SignetEventName.RespondBidirectionalEvent,
    ]);
  });
});
