// Local MPC watcher: poll the contract ledger and service each new signing request once,
// the way the real MPC reacts to on-chain requests instead of being handed work directly.
import { ethers } from 'ethers';
import * as api from '../api';
import type { VaultProviders } from '../common-types';
import { simulateMpcResponse, type MpcResult } from './mpc-simulator';

export interface MpcWatcher {
  /** Resolve with the response the watcher produced for `rid` (waits until it's serviced). */
  awaitResponse: (rid: Uint8Array, timeoutMs?: number) => Promise<MpcResult>;
  /** Stop polling. */
  stop: () => void;
}

/**
 * Start polling `getLedgerState`. Every new entry in `signetRequestNonce` (a request the
 * watcher hasn't seen) is serviced exactly once via `simulateMpcResponse` — read the request,
 * broadcast + observe the EVM tx, Schnorr-sign the result — and the response is cached. The
 * watcher only signs requests it observes on-chain; it does not submit the Midnight call
 * (claim is submitted by the user; claimRefund by the test, which controls forged-sig cases).
 */
export const startMpcWatcher = (opts: {
  providers: VaultProviders;
  contractAddress: string;
  provider: ethers.JsonRpcProvider;
  secp256k1RootPriv: string;
  jubjubSk: bigint;
  pollMs?: number;
}): MpcWatcher => {
  const { providers, contractAddress, provider, secp256k1RootPriv, jubjubSk, pollMs = 1000 } = opts;
  const hex = (rid: Uint8Array): string => Buffer.from(rid).toString('hex');

  const serviced = new Map<string, MpcResult>();
  const waiters = new Map<string, Array<(r: MpcResult) => void>>();
  const inFlight = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let ledger: any = null;
    try {
      ledger = await api.getLedgerState(providers, contractAddress);
    } catch { /* transient read error → retry next tick */ }

    if (ledger) {
      for (const [rid] of ledger.signetRequestNonce as Iterable<[Uint8Array, bigint]>) {
        const h = hex(rid);
        if (serviced.has(h) || inFlight.has(h)) continue;
        inFlight.add(h);
        try {
          const res = await simulateMpcResponse({
            ledger, contractAddress, rid, provider, secp256k1RootPriv, jubjubSk,
          });
          serviced.set(h, res);
          (waiters.get(h) ?? []).forEach((w) => w(res));
          waiters.delete(h);
        } catch {
          // leave un-serviced; a later tick retries with a fresh ledger
        } finally {
          inFlight.delete(h);
        }
      }
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  timer = setTimeout(tick, 0);

  return {
    awaitResponse: (rid, timeoutMs = 60_000) => {
      const h = hex(rid);
      const existing = serviced.get(h);
      if (existing) return Promise.resolve(existing);
      return new Promise<MpcResult>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`MPC watcher: no response for ${h} within ${timeoutMs}ms`)),
          timeoutMs,
        );
        const list = waiters.get(h) ?? [];
        list.push((r) => { clearTimeout(t); resolve(r); });
        waiters.set(h, list);
      });
    },
    stop: () => { stopped = true; clearTimeout(timer); },
  };
};
