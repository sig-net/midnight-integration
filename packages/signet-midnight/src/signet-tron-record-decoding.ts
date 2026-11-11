// Raw-cell decoding of a stored Tron request record: measure the calldata
// capacity the requester contract was compiled with from the cell's declared
// alignment widths, instantiate the record descriptor once and decode once.
// The TS twin of the Tron capacity measurement in the MPC's Rust reader
// (chain-signatures/chain-midnight/src/reader.rs) and MUST stay in lockstep
// with it.

import type { AlignedValue } from "@midnight-ntwrk/compact-runtime";

import { declaredWidths, decodeExactly } from "./compact-descriptors.ts";
import type { SignBidirectionalEvent } from "./signet-requests.ts";
import { tronSignBidirectionalEventDescriptor, type TronTxParams } from "./signet-tron-requests.ts";

// Atom layout of a Tron request record: the fixed atom count, the fixed head
// before the calldata words (keyVersion through calldata.noWords) and the
// fixed tail (executionDest, signatureDest, params and the two schemas). A
// stored cell holds TRON_FIXED_ATOMS + maxCalldataWords atoms.
const TRON_FIXED_ATOMS = 20;
const TRON_HEAD_ATOMS = 15;
const TRON_TAIL_ATOMS = 5;

/**
 * Decode a stored Tron request record in one pass, refusing a cell whose
 * declared widths are not a Tron record's. Every atom between the fixed head
 * and the fixed tail is a `Bytes<32>` calldata word slot, so the tail anchor
 * alone measures the capacity, and the schema widths come from the last two
 * atoms' DECLARED lengths. Does NOT verify the record against the id it is
 * filed under, and does NOT check the `txParamType` tag: the dispatching
 * caller does.
 *
 * @param cell - The record cell as stored (value atoms plus alignment).
 * @param what - Error-message subject.
 * @returns The decoded record.
 * @throws {Error} If the cell is not a decodable Tron request record.
 */
export function decodeTronSignBidirectionalEvent(
  cell: AlignedValue,
  what: string,
): SignBidirectionalEvent<TronTxParams> {
  const widths = declaredWidths(cell, what);
  if (widths.length < TRON_FIXED_ATOMS) {
    throw new Error(
      `${what} has ${String(widths.length)} value atoms, fewer than the ` +
        `${String(TRON_FIXED_ATOMS)} its fixed fields need`,
    );
  }
  const tail = widths.length - TRON_TAIL_ATOMS;
  if (!widths.slice(TRON_HEAD_ATOMS, tail).every((width) => width === 32)) {
    throw new Error(`${what}'s calldata-word region holds a non-Bytes<32> atom`);
  }
  const lenOutputDeserialization = widths.at(-2);
  const lenRespondSerialization = widths.at(-1);
  if (lenOutputDeserialization === undefined || lenRespondSerialization === undefined) {
    throw new Error(`${what} ends before its serialisation schemas`);
  }
  return decodeExactly(
    tronSignBidirectionalEventDescriptor(
      tail - TRON_HEAD_ATOMS,
      lenOutputDeserialization,
      lenRespondSerialization,
    ),
    cell.value,
    what,
  );
}
