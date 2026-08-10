// Raw-cell decoding of a stored evmType2 request record: measure the
// capacity instantiation the requester contract was compiled with from the
// cell's declared alignment widths, instantiate the record descriptor once
// and decode once. The TS twin of the capacity measurement in the MPC's Rust
// reader (chain-signatures/chain-midnight/src/reader.rs) and MUST stay in
// lockstep with it. The chain-agnostic reading and the per-decomposition
// dispatch live in signature-requests-state-reader.ts.

import type { AlignedValue } from "@midnight-ntwrk/compact-runtime";

import { declaredWidths, decodeExactly } from "./compact-descriptors.ts";
import { signBidirectionalEventDescriptor } from "./signet-evtype2tx-requests.ts";
import type { SignBidirectionalEvent } from "./signet-requests.ts";

// Atom layout of an evmType2 request record: the fixed atom count, the
// fixed head before the calldata words, and the fixed tail (caip2Id + the
// two schemas). A stored cell holds
// EVM_TYPE2_FIXED_ATOMS + maxCalldataWords
//   + maxAccessListEntries * (2 + maxStorageKeysPerEntry) atoms.
const EVM_TYPE2_FIXED_ATOMS = 22;
const EVM_TYPE2_HEAD_ATOMS = 18;
const EVM_TYPE2_TAIL_ATOMS = 3;

/** A record's capacity instantiation, recovered from declared widths. */
interface EvmType2Capacities {
  maxCalldataWords: number;
  maxAccessListEntries: number;
  maxStorageKeysPerEntry: number;
}

/**
 * Recover the sizing parameters the requester's contract was compiled with
 * (`#maxCalldataWords`, `#maxAccessListEntries`, `#maxStorageKeysPerEntry`)
 * from the declared widths alone. The tail anchors from the end: calldata
 * words, storage keys and `caip2Id` are all `Bytes<32>`, so no forward scan
 * can find the boundaries.
 *
 * @param widths - The record's declared atom widths.
 * @param what - Error-message subject.
 * @returns The capacity instantiation.
 * @throws {Error} If the widths are not an evmType2 record's.
 */
function evmType2Capacities(widths: readonly number[], what: string): EvmType2Capacities {
  if (widths.length < EVM_TYPE2_FIXED_ATOMS) {
    throw new Error(
      `${what} has ${String(widths.length)} value atoms, fewer than the ` +
        `${String(EVM_TYPE2_FIXED_ATOMS)} its fixed fields need`,
    );
  }
  const tail = widths.length - EVM_TYPE2_TAIL_ATOMS;

  let index = EVM_TYPE2_HEAD_ATOMS;
  while (index < tail && widths[index] === 32) {
    index += 1;
  }
  const maxCalldataWords = index - EVM_TYPE2_HEAD_ATOMS;

  const boundary = index < tail ? widths[index] : undefined;
  if (boundary !== 1) {
    const found = boundary === undefined ? "the record's tail" : `Bytes<${String(boundary)}>`;
    throw new Error(
      `expected the Bytes<1> access-list entry count after ${String(maxCalldataWords)} ` +
        `calldata words, found ${found}`,
    );
  }
  index += 1;

  const region = widths.slice(index, tail);
  const maxAccessListEntries = region.filter((width) => width === 20).length;
  let maxStorageKeysPerEntry: number;
  if (maxAccessListEntries === 0) {
    if (region.length !== 0) {
      throw new Error(
        `the access-list region holds ${String(region.length)} atoms but declares no ` +
          `Bytes<20> entry address`,
      );
    }
    maxStorageKeysPerEntry = 0;
  } else {
    if (region.length % maxAccessListEntries !== 0) {
      throw new Error(
        `the access-list region's ${String(region.length)} atoms do not divide evenly ` +
          `across ${String(maxAccessListEntries)} entries`,
      );
    }
    const perEntry = region.length / maxAccessListEntries;
    if (perEntry < 2) {
      throw new Error(
        `each access-list entry needs at least an address and a key count, ` +
          `got ${String(perEntry)} atoms`,
      );
    }
    maxStorageKeysPerEntry = perEntry - 2;
  }
  return { maxCalldataWords, maxAccessListEntries, maxStorageKeysPerEntry };
}

/**
 * Decode a stored evmType2 request record in one pass, refusing a cell whose
 * declared widths are not a signet record's. Measures the capacity
 * instantiation from the declared alignment widths (the schema widths from
 * the last two atoms' DECLARED lengths), instantiates the descriptor once
 * and decodes once. Does NOT verify the record against the id it is filed
 * under, and does NOT check the `txParamType` tag: the dispatching caller
 * does.
 *
 * @param cell - The record cell as stored (value atoms plus alignment).
 * @param what - Error-message subject.
 * @returns The decoded record.
 * @throws {Error} If the cell is not a decodable evmType2 request record.
 */
export function decodeEvmType2SignBidirectionalEvent(
  cell: AlignedValue,
  what: string,
): SignBidirectionalEvent {
  const widths = declaredWidths(cell, what);
  const capacities = evmType2Capacities(widths, what);
  const lenOutputDeserialization = widths.at(-2);
  const lenRespondSerialization = widths.at(-1);
  if (lenOutputDeserialization === undefined || lenRespondSerialization === undefined) {
    throw new Error(
      `${what} has ${String(widths.length)} value atoms: too few to hold the ` +
        `trailing output-deserialization and respond-serialization schemas`,
    );
  }
  return decodeExactly(
    signBidirectionalEventDescriptor(
      capacities.maxCalldataWords,
      capacities.maxAccessListEntries,
      capacities.maxStorageKeysPerEntry,
      lenOutputDeserialization,
      lenRespondSerialization,
    ),
    cell.value,
    what,
  );
}
