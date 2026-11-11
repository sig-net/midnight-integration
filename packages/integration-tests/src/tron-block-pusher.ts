// The block pusher of the Tron e2e. TRE produces a block only when a
// transaction arrives, and the MPC (the fakenet here) never sends one: it
// only reads solidified receipts and blocks. So while the e2e waits on
// anything TRE must solidify (a receipt, an expiry, an attestation that
// needs either), it sends a filler TRX transfer from the dev funder every
// couple of seconds to keep blocks coming.

import { tronAddressFromEvm } from "@sig-net/midnight";

import { sendTrxFromFunder } from "./local-tron.ts";

/** How often the pusher sends a filler transfer, milliseconds. */
const PUSH_INTERVAL_MS = 2000;

/**
 * The filler transfers' recipient: a fixed address nobody holds a key for.
 * The first transfer creates the account, every later one only moves 1 sun.
 */
const PUSHER_SINK = tronAddressFromEvm("0x000000000000000000000000000000000000dEaD");

/**
 * Run `action` while a filler TRX transfer goes out every
 * {@link PUSH_INTERVAL_MS}, so TRE keeps producing and solidifying blocks
 * until `action` settles. A failed filler transfer is logged and the next
 * one tried: a stalled chain shows up as `action`'s own timeout.
 *
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE.
 * @param action - The wait to keep the chain moving for.
 * @returns Whatever `action` resolves to.
 */
export async function withTronBlockPusher<T>(rpcUrl: string, action: () => Promise<T>): Promise<T> {
  const stop = new AbortController();
  const pusher = (async () => {
    while (!stop.signal.aborted) {
      try {
        await sendTrxFromFunder(rpcUrl, PUSHER_SINK, 1n);
      } catch (error) {
        console.warn(`block pusher: filler transfer failed (${String(error)})`);
      }
      await new Promise((resolve) => setTimeout(resolve, PUSH_INTERVAL_MS));
    }
  })();
  try {
    return await action();
  } finally {
    stop.abort();
    await pusher;
  }
}
