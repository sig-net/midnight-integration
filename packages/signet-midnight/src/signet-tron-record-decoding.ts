import type { AlignedValue } from "@midnight-ntwrk/compact-runtime";

import { declaredWidths, decodeExactly } from "./compact-descriptors.ts";
import type { SignBidirectionalEvent } from "./signet-requests.ts";
import { tronSignBidirectionalEventDescriptor, type TronTxParams } from "./signet-tron-requests.ts";

const TRON_FIXED_ATOMS = 20;
const TRON_HEAD_ATOMS = 15;
const TRON_TAIL_ATOMS = 5;

/**
 * @param cell - The record cell as stored (value atoms plus alignment)
 * @param what - Error-message subject
 * @returns The decoded record
 * @throws {Error} If the cell is not a decodable Tron request record
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
