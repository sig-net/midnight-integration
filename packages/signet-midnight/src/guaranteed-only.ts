// Sig's fallibility model, part one: Sig signs only for calls that land in
// the GUARANTEED section of their transaction.
//
// Midnight's transaction builder decides the section at construction time,
// from the transcript's estimated execution cost (midnight-ledger
// `construct.rs`, `partition_transcripts`). A call that does not fit the
// guaranteed budget is demoted WHOLE to the fallible section, with no error
// — and a fallible section can fail at landing after fees are paid, dropping
// the request the signer's event would have announced. The Compact circuit
// cannot know which side it lands on, so the check lives here, on the built
// transaction, before it is proven.

import type { ProofProvider, ProveTxConfig } from "@midnight-ntwrk/midnight-js-types";

/** What midnight-js hands a proof provider: the built, unproven transaction. */
type UnprovenTx = Parameters<ProofProvider["proveTx"]>[0];

/** The slice of a transaction this check reads. */
export type CallSections = Pick<UnprovenTx, "intents">;

/** The slice of a ledger `ContractCall` this check reads. */
interface CallTranscripts {
  readonly address: string;
  readonly entryPoint: Uint8Array | string;
  readonly guaranteedTranscript: unknown;
  readonly fallibleTranscript: unknown;
}

/** A contract call the builder placed, wholly or partly, in the fallible section. */
export interface FallibleCall {
  /** The intent's segment id. */
  readonly segment: number;
  /** The called contract's address. */
  readonly address: string;
  /** The circuit name. */
  readonly entryPoint: string;
  /** `true` when nothing of the call fits the guaranteed section. */
  readonly whole: boolean;
}

const isContractCall = (action: unknown): action is CallTranscripts =>
  typeof action === "object" &&
  action !== null &&
  "guaranteedTranscript" in action &&
  "fallibleTranscript" in action;

const entryPointName = (entryPoint: Uint8Array | string): string =>
  typeof entryPoint === "string" ? entryPoint : new TextDecoder().decode(entryPoint);

/**
 * The contract calls of a built transaction that would run in a fallible
 * section, in intent order.
 *
 * @param tx - The built (unproven or proven) transaction.
 * @returns One entry per call with a fallible transcript; empty when every call is wholly guaranteed.
 */
export function fallibleCalls(tx: CallSections): FallibleCall[] {
  const found: FallibleCall[] = [];
  for (const [segment, intent] of tx.intents ?? []) {
    for (const action of intent.actions) {
      if (isContractCall(action) && action.fallibleTranscript !== undefined) {
        found.push({
          segment,
          address: action.address,
          entryPoint: entryPointName(action.entryPoint),
          whole: action.guaranteedTranscript === undefined,
        });
      }
    }
  }
  return found;
}

/** Thrown by {@link assertGuaranteedOnly}; carries the offending calls. */
export class FallibleCallError extends Error {
  /**
   * @param calls - The calls the builder placed in a fallible section; non-empty.
   */
  constructor(readonly calls: readonly FallibleCall[]) {
    super(
      "Sig signs guaranteed calls only, and the transaction builder placed " +
        `${calls.length === 1 ? "this call" : "these calls"} in the fallible section: ` +
        calls
          .map(
            (c) =>
              `${c.entryPoint} on ${c.address} (segment ${String(c.segment)}, ` +
              `${c.whole ? "whole" : "the tail after a checkpoint"})`,
          )
          .join("; ") +
        ". The call's transcript exceeds the guaranteed-section budget (midnight-ledger " +
        "`partition_transcripts`): shrink the circuit's ledger work, or split it so the " +
        "request that calls the signer is its own smaller transaction.",
    );
    this.name = "FallibleCallError";
  }
}

/**
 * Require every contract call of `tx` to be wholly guaranteed.
 *
 * @param tx - The built transaction.
 * @throws {FallibleCallError} When any call has a fallible transcript.
 */
export function assertGuaranteedOnly(tx: CallSections): void {
  const calls = fallibleCalls(tx);
  if (calls.length > 0) {
    throw new FallibleCallError(calls);
  }
}

/**
 * A {@link ProofProvider} that refuses to prove a transaction with a fallible
 * contract call — the earliest point midnight-js hands the built transaction
 * to integrator code, so no proof is spent on a request Sig would not sign.
 *
 * @param base - The proof provider that does the proving.
 * @returns `base`, with `proveTx` guarded by {@link assertGuaranteedOnly}.
 */
export function guaranteedOnlyProofProvider(base: ProofProvider): ProofProvider {
  return {
    ...base,
    async proveTx(unprovenTx: UnprovenTx, proveTxConfig?: ProveTxConfig) {
      assertGuaranteedOnly(unprovenTx);
      return await base.proveTx(unprovenTx, proveTxConfig);
    },
  };
}
