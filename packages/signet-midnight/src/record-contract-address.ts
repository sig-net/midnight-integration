// Rewrites one deployed network's entry of a published contract's address
// table in constants.ts, as source text. The pure core of the package-root
// record-contract-address.ts entrypoint, kept in src so it typechecks with the
// package and its table surgery is unit-tested against the real file. Not part
// of the package's export surface.

import { bytesToHex } from "./byte-codecs.ts";
import type { ContractAddress } from "./compact-descriptors.ts";
import { type DeployedNetwork, MidnightNetwork } from "./constants.ts";

/** A contract whose per-network addresses constants.ts publishes. */
export enum PublishedContract {
  /** The signet singleton, behind `getSignetContractAddress`. */
  SignetContract = "signet-contract",
  /** The signet responder, behind `getResponderContractAddress`. */
  SignetResponder = "signet-responder",
}

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
 * rejected, as it deploys its own protocol contracts per stack and has no
 * row in either table.
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

/**
 * Whether a name names a published contract.
 *
 * @param name - The name to classify.
 * @returns Whether the name is a {@link PublishedContract}.
 */
function isPublishedContract(name: string): name is PublishedContract {
  const names: readonly string[] = Object.values(PublishedContract);
  return names.includes(name);
}

/**
 * Resolve a contract name to a published contract.
 *
 * @param name - The contract's package directory name, e.g. `signet-responder`.
 * @returns The name as a {@link PublishedContract}.
 * @throws {Error} If the name is not a published contract.
 */
export function parsePublishedContract(name: string): PublishedContract {
  if (!isPublishedContract(name)) {
    throw new Error(
      `unknown contract "${name}": expected one of ${Object.values(PublishedContract).join(", ")}`,
    );
  }
  return name;
}

/** The outcome of {@link recordContractAddress}: the new source and the diff it made. */
export interface RecordedContractAddress {
  /** The full constants.ts source with the entry rewritten. */
  source: string;
  /** The table row as it was, e.g. `[MidnightNetwork.Stagenet]: ""`. */
  previousEntry: string;
  /** The table row as it is now. */
  entry: string;
}

/** Each published contract's address table in constants.ts. */
const ADDRESS_TABLES: Record<PublishedContract, string> = {
  [PublishedContract.SignetContract]: "signetContractAddresses",
  [PublishedContract.SignetResponder]: "responderContractAddresses",
};

/**
 * Record a deployed contract's address for one network in the source text of
 * constants.ts: a single exact-match replace of that network's row inside the
 * contract's address table. The replace is scoped to that table, as the file
 * holds other tables keyed by the very same enum members. Anything else
 * throws without producing a source, so a silent no-op can never masquerade
 * as a recorded deploy: a missing or unclosed table, or a row that matches
 * zero or several times.
 *
 * @param source - The current constants.ts source text.
 * @param contract - The contract whose address table to edit.
 * @param network - The network whose row to rewrite.
 * @param address - The deployed contract's address.
 * @returns The rewritten source with the rows before and after.
 * @throws {Error} If the table or the network's row cannot be located exactly once.
 */
export function recordContractAddress(
  source: string,
  contract: PublishedContract,
  network: DeployedNetwork,
  address: ContractAddress,
): RecordedContractAddress {
  const tableName = ADDRESS_TABLES[contract];
  const memberName = Object.entries(MidnightNetwork).find(([, id]) => id === network)?.[0];
  if (memberName === undefined) {
    throw new Error(`"${network}" is not a MidnightNetwork member`);
  }

  const tableStart = source.indexOf(`const ${tableName}`);
  if (tableStart === -1) {
    throw new Error(`no "${tableName}" table in the source`);
  }
  const tableEnd = source.indexOf("\n};", tableStart);
  if (tableEnd === -1) {
    throw new Error(`the "${tableName}" table is not closed by "\\n};"`);
  }
  const table = source.slice(tableStart, tableEnd);

  const rowPattern = new RegExp(`\\[MidnightNetwork\\.${memberName}\\]: "[0-9a-fA-F]*"`, "g");
  const rows = table.match(rowPattern) ?? [];
  const previousEntry = rows.at(0);
  if (rows.length !== 1 || previousEntry === undefined) {
    throw new Error(
      `expected exactly one ${network} row in ${tableName}, found ${String(rows.length)}`,
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
