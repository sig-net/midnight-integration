// Rewrites one deployed network's entry of the `signetContractAddresses`
// table in constants.ts, as source text. The pure core of the package-root
// record-contract-address.ts entrypoint, kept in src so it typechecks with the
// package and its table surgery is unit-tested against the real file. Not part
// of the package's export surface.

import { bytesToHex } from "./byte-codecs.ts";
import type { ContractAddress } from "./compact-descriptors.ts";
import { type DeployedNetwork, MidnightNetwork } from "./constants.ts";

/** Every network with a row in the published per-network tables. */
const DEPLOYED_NETWORKS: readonly DeployedNetwork[] = Object.values(MidnightNetwork).filter(
  (network): network is DeployedNetwork => network !== MidnightNetwork.Undeployed,
);

/**
 * Whether a network id names a deployed network: one with a row in the
 * published per-network tables.
 *
 * @param networkId - The network id to classify.
 * @returns Whether the id is a {@link DeployedNetwork}.
 */
function isDeployedNetwork(networkId: string): networkId is DeployedNetwork {
  const ids: readonly string[] = DEPLOYED_NETWORKS;
  return ids.includes(networkId);
}

/**
 * Resolve a network id to a deployed network. The local standalone stack is
 * rejected, as it deploys its own singleton per stack and has no row.
 *
 * @param networkId - The network id to resolve, e.g. `stagenet`.
 * @returns The id as a {@link DeployedNetwork}.
 * @throws {Error} If the id names no deployed network.
 */
export function parseDeployedNetwork(networkId: string): DeployedNetwork {
  if (!isDeployedNetwork(networkId)) {
    throw new Error(
      `unknown network "${networkId}": expected one of ${DEPLOYED_NETWORKS.join(", ")}`,
    );
  }
  return networkId;
}

/** The constants.ts table {@link recordContractAddress} edits. */
const TABLE_NAME = "signetContractAddresses";

/** The outcome of {@link recordContractAddress}: the new source and the diff it made. */
export interface RecordedContractAddress {
  /** The full constants.ts source with the entry rewritten. */
  source: string;
  /** The table row as it was, e.g. `[MidnightNetwork.Stagenet]: ""`. */
  previousEntry: string;
  /** The table row as it is now. */
  entry: string;
}

/**
 * Record a deployed signet singleton's address for one network in the source
 * text of constants.ts: a single exact-match replace of that network's row
 * inside the `signetContractAddresses` literal. The replace is scoped to that
 * table, as the file holds a second table keyed by the very same enum
 * members. Anything else throws without producing a source, so a silent
 * no-op can never masquerade as a recorded deploy: a missing or unclosed
 * table, or a row that matches zero or several times.
 *
 * @param source - The current constants.ts source text.
 * @param network - The network whose row to rewrite.
 * @param address - The deployed singleton's address.
 * @returns The rewritten source with the rows before and after.
 * @throws {Error} If the table or the network's row cannot be located exactly once.
 */
export function recordContractAddress(
  source: string,
  network: DeployedNetwork,
  address: ContractAddress,
): RecordedContractAddress {
  const memberName = Object.entries(MidnightNetwork).find(([, id]) => id === network)?.[0];
  if (memberName === undefined) {
    throw new Error(`"${network}" is not a MidnightNetwork member`);
  }

  const tableStart = source.indexOf(`const ${TABLE_NAME}`);
  if (tableStart === -1) {
    throw new Error(`no "${TABLE_NAME}" table in the source`);
  }
  const tableEnd = source.indexOf("\n};", tableStart);
  if (tableEnd === -1) {
    throw new Error(`the "${TABLE_NAME}" table is not closed by "\\n};"`);
  }
  const table = source.slice(tableStart, tableEnd);

  const rowPattern = new RegExp(`\\[MidnightNetwork\\.${memberName}\\]: "[0-9a-fA-F]*"`, "g");
  const rows = table.match(rowPattern) ?? [];
  const previousEntry = rows.at(0);
  if (rows.length !== 1 || previousEntry === undefined) {
    throw new Error(
      `expected exactly one ${network} row in ${TABLE_NAME}, found ${String(rows.length)}`,
    );
  }

  const entry = `[MidnightNetwork.${memberName}]: "${bytesToHex(address.bytes)}"`;
  return {
    source:
      source.slice(0, tableStart) + table.replace(previousEntry, entry) + source.slice(tableEnd),
    previousEntry,
    entry,
  };
}
