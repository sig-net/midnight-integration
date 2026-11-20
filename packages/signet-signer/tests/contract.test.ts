// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime (no network, no proving). Its one circuit,
// signBidirectional, emits one named Misc event with a packed payload and
// verifies nothing in circuit: verification is deliberately the reader's
// job. The tests pin exactly that: the emit lands as one event, repeats
// append, and the payload decodes back through the @sig-net/midnight event
// decoders. That decode is the LOCKSTEP CHECK between the contract's emit
// literal and the TS byte-plumbing twins: it runs against REAL emitted
// events, so an offset or field-order drift on either side fails here.

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import {
  bytesToHex,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetLogEvents,
  pureCircuits as signetCircuits,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  type SignetMiscEvent,
} from "@sig-net/midnight";
import { describe, expect, it } from "vitest";

import {
  Contract,
  createSignetSignerPrivateState,
  type SignetSignerPrivateState,
  witnesses,
} from "../src/index.ts";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// Request ids the notifications below carry.
const REQUEST_A = bytes(32, 0xaa);
const REQUEST_B = bytes(32, 0xbb);

// A caller contract address as the packer consumes it (raw 32 bytes). The
// registering client passes kernel.self(), but here a fixed fixture suffices.
const NOTIFYING_CALLER = { bytes: bytes(32, 0xc1) };

// ---- Harness ----

const deployContract = async (circuitId: string) => {
  const contract = new Contract<SignetSignerPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = await contract.initialState(
    createConstructorContext(createSignetSignerPrivateState(), CPK),
  );
  const contractAddress = sampleContractAddress();
  const ctx = createCircuitContext({
    circuitId,
    contractAddress,
    coinPublicKeyOrZswapState: CPK,
    contractState: currentContractState,
    privateState: currentPrivateState,
  });
  return { contract, ctx, contractAddress };
};

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

/** All bytes of `payload` from `offset` on must be the emit literal's zero fill. */
const expectZeroPadding = (payload: Uint8Array, offset: number) => {
  expect(payload).toHaveLength(SIGNET_EVENT_PAYLOAD_LENGTH);
  expect(payload.slice(offset)).toEqual(new Uint8Array(SIGNET_EVENT_PAYLOAD_LENGTH - offset));
};

// ---- Tests ----

describe("signBidirectional", () => {
  // These callers are flat, so a field number is a depth-1 path [field].
  const notification = (requestsField: bigint) =>
    signetCircuits.constructSignBidirectionalEventNotificationV1(NOTIFYING_CALLER, 1n, [
      requestsField,
      0n,
      0n,
      0n,
    ]);

  it("emits the notification as a SignBidirectionalEvent event (decode lockstep)", async () => {
    const { contract, ctx, contractAddress } = await deployContract("signBidirectional");

    const { result, context } = await contract.circuits.signBidirectional(
      ctx,
      REQUEST_A,
      notification(4n),
    );
    expect(result).toEqual([]);

    // The one emitted event, tagged with THIS contract's address.
    const events = decodeSignetLogEvents(context.events, contractAddress);
    expect(events).toHaveLength(1);
    const event = eventAt(events);
    expect(event.name).toBe(SignetEventName.SignBidirectionalEvent);

    // Emit literal: version (1) ++ requestId (32) ++ notification
    // payload (128) ++ zeros (95), pinned by raw offset here.
    expect(event.payload[0]).toBe(1); // version
    expect(event.payload.slice(1, 33)).toEqual(REQUEST_A);
    expect(event.payload.slice(33, 161)).toEqual(notification(4n).payload);
    expectZeroPadding(event.payload, 161);

    // The decode twin returns the declared id beside the record, and the
    // packed V1 payload decodes back to the caller pointer.
    const post = decodeSignBidirectionalEventNotificationPayload(event.payload);
    expect(post).toEqual({ requestId: REQUEST_A, event: notification(4n) });
    expect(decodeSignBidirectionalNotification(post.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(NOTIFYING_CALLER.bytes),
      requestsPath: [4],
    });
  });

  it("emits a repeat notify as its own event, nothing replaced", async () => {
    const { contract, ctx, contractAddress } = await deployContract("signBidirectional");

    const first = await contract.circuits.signBidirectional(ctx, REQUEST_A, notification(4n));
    const second = await contract.circuits.signBidirectional(
      first.context,
      REQUEST_B, // its own id under its own event
      notification(7n), // different index field: both emits must survive
    );

    const events = decodeSignetLogEvents(second.context.events, contractAddress);
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => {
        const post = decodeSignBidirectionalEventNotificationPayload(event.payload);
        return [post.requestId, decodeSignBidirectionalNotification(post.event).requestsPath];
      }),
    ).toEqual([
      [REQUEST_A, [4]],
      [REQUEST_B, [7]],
    ]);
  });
});
