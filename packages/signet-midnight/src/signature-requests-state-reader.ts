// MPC-style raw state reader for the signature-REQUESTS side: read a
// contract's signet request index out of its raw state by resolved
// ledger-tree path, as the MPC monitor and the event feed consume signet
// contracts. The generic tree walk lives in raw-contract-state.ts and the
// per-decomposition record decoding in signet-evtype2tx-record-decoding.ts.
//
// The read algorithm is the TS twin of the MPC's Rust reader
// (chain-signatures/chain-midnight/src/reader.rs) and must stay in lockstep
// with it: each record is decoded once, and id verification is a separate
// recompute-and-drop gate ({@link lookupSignetRequestAt}).

import type { AlignedValue } from "@midnight-ntwrk/compact-runtime";

import { decodeExactly } from "./compact-descriptors.ts";
import { type RawContractState, signetFieldNodeByPath } from "./raw-contract-state.ts";
import { decodeEvmType2SignBidirectionalEvent } from "./signet-evtype2tx-record-decoding.ts";
import { calculateRequestId } from "./signet-request-id.ts";
import {
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  requestIdType,
  type SignBidirectionalEvent,
  type SignBidirectionalEventIndex,
  TxParamType,
} from "./signet-requests.ts";

// Atom position of `txParamType` in a stored record: the chain-agnostic head
// of SignBidirectionalEvent (sender through txParamType) occupies the first
// 7 atoms whatever the decomposition, so the tag sits at the same index in
// every record.
const TX_PARAM_TYPE_ATOM = 6;

/**
 * Decode a stored request record: read the `txParamType` tag and hand the
 * cell to that decomposition's decoder, so a foreign param type fails by
 * name rather than as capacity arithmetic. Does NOT verify the record
 * against the id it is filed under.
 *
 * @param cell - The record cell as stored (value atoms plus alignment).
 * @returns The decoded record.
 * @throws {Error} If the cell is not a decodable request record of a known
 *   decomposition.
 */
function decodeSignBidirectionalEvent(cell: AlignedValue): SignBidirectionalEvent {
  const what = "request record";
  const atom = cell.value[TX_PARAM_TYPE_ATOM];
  if (atom === undefined) {
    throw new Error(`${what} ends before txParamType`);
  }
  if (atom.length > 1) {
    throw new Error(
      `${what} txParamType atom holds ${String(atom.length)} bytes, expected at most 1`,
    );
  }
  // The state layer trims trailing zeros, so evmType2 (0) arrives empty.
  const paramType = atom[0] ?? 0;
  switch (paramType) {
    case TxParamType.evmType2:
      return decodeEvmType2SignBidirectionalEvent(cell, what);
    default:
      throw new Error(`unsupported txParamType ${String(paramType)}`);
  }
}

/**
 * MPC-style read: parse a requesting contract's whole request index out of
 * raw contract state by caller-supplied field position. A contract chooses
 * its own layout, so the caller must know where the index sits.
 *
 * Records are decoded, not verified against the ids they are filed under:
 * {@link lookupSignetRequestAt} is the verified lookup.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`
 *   from the indexer or `ctx.currentQueryContext.state` from the simulator.
 * @param requestsIndexPath - Resolved ledger-tree path of the request index.
 * @returns The decoded request index, keyed by hex request id.
 * @throws {Error} If the field is missing, has the wrong state-value shape, or a
 *   record is not a decodable evmType2 request record.
 */
export function readSignetRequestsIndexFromState(
  raw: RawContractState,
  requestsIndexPath: readonly number[],
): SignBidirectionalEventIndex {
  const map = signetFieldNodeByPath(raw, requestsIndexPath).asMap();
  if (map === undefined) {
    throw new Error(`Ledger field at path ${JSON.stringify(requestsIndexPath)} is not a Map`);
  }
  const requestsIndex: SignBidirectionalEventIndex = new Map();
  for (const key of map.keys()) {
    const requestId = requestIdHex(decodeExactly(requestIdType, key.value, "request index key"));
    const cell = map.get(key)?.asCell();
    if (cell === undefined) continue;
    requestsIndex.set(requestId, decodeSignBidirectionalEvent(cell));
  }
  return requestsIndex;
}

/**
 * Look up ONE request by id in a contract's request index at an arbitrary
 * ledger field: the single-record sibling of
 * {@link readSignetRequestsIndexFromState} and the discovery primitive of
 * the event-based feed. The recompute-and-drop gate: the decode never sees
 * the id, so the final recompute is the only thing binding a record's
 * contents to the key it was filed under, and a mismatch (a spoofed or
 * wrongly filed record) is dropped. Every non-membership case returns
 * `undefined` rather than throwing, and the caller MUST drop such a pointer.
 *
 * @param raw - Raw contract state, e.g. `queryContractState(address).data`.
 * @param requestsPath - Resolved ledger-tree path of the request index in
 *   `raw`, as the notification carries it.
 * @param requestId - The request id to look up.
 * @returns The stored, id-verified request record, or `undefined` when it is
 *   not a member.
 */
export function lookupSignetRequestAt(
  raw: RawContractState,
  requestsPath: readonly number[],
  requestId: RequestIdHex,
): SignBidirectionalEvent | undefined {
  let node;
  try {
    node = signetFieldNodeByPath(raw, requestsPath);
  } catch {
    return undefined; // path out of range for this contract
  }
  const map = node.asMap();
  if (map === undefined) {
    return undefined; // the named field is not a request index
  }
  // The ledger's own keyed lookup on the ledger's own key type: toValue
  // produces the canonical (zero-trimmed) key form the map stores.
  const entry = map.get({
    value: requestIdType.toValue(requestIdBytes(requestId)),
    alignment: requestIdType.alignment(),
  });
  const cell = entry?.asCell();
  if (cell === undefined) {
    return undefined; // id absent, or its entry is not a cell
  }
  let record: SignBidirectionalEvent;
  try {
    record = decodeSignBidirectionalEvent(cell);
  } catch {
    return undefined; // a cell that is not a decodable request record
  }
  if (requestIdHex(calculateRequestId(record)) !== requestId) {
    return undefined; // spoofed or wrongly filed record
  }
  return record;
}
