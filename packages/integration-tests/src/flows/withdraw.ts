// The withdraw flow split into legs, so a flow file can INTERVENE mid-flow —
// the failure-refund test broadcasts a doomed transfer between the signature
// and the attestation, and needs the failure attestation to flow through
// (deliberately: no leg here asserts EVM success; the caller decides). The
// happy-day file does NOT use these legs — its long-hand steps carry their
// own assertions. Per AGENTS.md, this file only SEQUENCES exported cli
// commands — every orchestration primitive lives in the cli.

import {
  completeWithdraw,
  pollSignatureResponse,
  pollRespondBidirectional,
  requestWithdraw,
} from "@midnight-erc20-vault/cli";
import type {
  RequestIdHex,
  RespondBidirectional,
} from "@midnight-erc20-vault/signet-midnight";
import type { Transaction } from "ethers";
import { requireEnv } from "../e2e-env.ts";
import type { E2eSession } from "../session.ts";

const MINUTE = 60_000;

/** Options for {@link requestWithdrawLeg}. */
export interface RequestWithdrawLegOptions {
  /** Withdraw amount in ERC20 base units (escrowed from the caller's shielded balance). */
  readonly amount: bigint;
  /** Destination EVM address (20-byte 0x hex) receiving the ERC20. */
  readonly destEvmAddress: string;
  /** Nonce of the VAULT's derived EVM account (the withdraw tx sender). */
  readonly evmNonce: bigint;
}

/**
 * Leg 1: escrow shielded vault tokens and record the withdraw signature
 * request on the vault's ledger via the cli's `requestWithdraw`.
 *
 * @param session - The flow file's shared session (wallet + cli context).
 * @param opts - The withdraw arguments.
 * @returns The withdraw request id.
 * @throws If the vault is uninitialized, the caller's shielded balance
 *   cannot cover `opts.amount`, or the recomputed id is not on the ledger.
 */
export async function requestWithdrawLeg(
  session: E2eSession,
  opts: RequestWithdrawLegOptions,
): Promise<RequestIdHex> {
  const context = await session.cliContext();
  return requestWithdraw(context, {
    amount: opts.amount,
    destEvmAddress: opts.destEvmAddress,
    evmNonce: opts.evmNonce,
  });
}

/** Options for the request-id-keyed withdraw legs. */
export interface WithdrawLegOptions {
  /** The withdraw request id (from {@link requestWithdrawLeg}). */
  readonly requestId: RequestIdHex;
}

/**
 * Leg 2: poll the signet contract until the MPC posts a valid signature for
 * the withdraw request, verified against the VAULT's derived account
 * (`EVM_VAULT_ADDRESS` — withdraw transfers are sent from the vault).
 *
 * @param session - The flow file's shared session (wallet + cli context).
 * @param env - The setup-populated env accumulator.
 * @param opts - The request to poll for.
 * @returns The broadcast-ready MPC-signed EVM transaction.
 * @throws If no valid response is posted within the poll window.
 */
export async function pollSignedWithdrawLeg(
  session: E2eSession,
  env: NodeJS.ProcessEnv,
  opts: WithdrawLegOptions,
): Promise<Transaction> {
  const context = await session.cliContext();
  return pollSignatureResponse(context, {
    requestId: opts.requestId,
    intervalMs: 1000,
    timeoutMs: 2 * MINUTE,
    expectedSigner: requireEnv(env, "EVM_VAULT_ADDRESS"),
  });
}

/**
 * Leg 3: poll the signet contract until the MPC's respond-bidirectional
 * attestation of the withdraw transfer's EVM outcome appears.
 *
 * Deliberately asserts NOTHING about the attested outcome — unlike the
 * happy-day flow, the failure-refund flow needs a failure attestation to
 * flow through to {@link settleWithdrawLeg}. Judge it in the caller with
 * `executionSucceeded(attestation.serializedOutput)`.
 *
 * @param session - The flow file's shared session (wallet + cli context).
 * @param opts - The request to poll for.
 * @returns The attestation record, success or failure.
 * @throws If no attestation is posted within the poll window.
 */
export async function pollWithdrawAttestationLeg(
  session: E2eSession,
  opts: WithdrawLegOptions,
): Promise<RespondBidirectional> {
  const context = await session.cliContext();
  return pollRespondBidirectional(context, {
    requestId: opts.requestId,
    intervalMs: 1000,
    timeoutMs: 3 * MINUTE,
  });
}

/**
 * Leg 4: settle the withdrawal via the cli's `completeWithdraw` — the
 * circuit verifies the posted attestation and branches on the EVM result
 * (success finalizes; failure re-mints the escrowed value to the pinned
 * refund recipient). Asserting the ledger outcome (request + refund-marker
 * consumption) is the caller's job.
 *
 * @param session - The flow file's shared session (wallet + cli context).
 * @param opts - The request to settle.
 * @throws If no attestation is posted for the request, or the withdrawal
 *   was already settled (no pending marker on the ledger).
 */
export async function settleWithdrawLeg(
  session: E2eSession,
  opts: WithdrawLegOptions,
): Promise<void> {
  const context = await session.cliContext();
  await completeWithdraw(context, { requestId: opts.requestId });
}
