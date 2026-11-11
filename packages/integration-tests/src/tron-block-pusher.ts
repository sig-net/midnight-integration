import { tronAddressFromEvm } from "@sig-net/midnight";

import { sendTrxFromFunder } from "./local-tron.ts";

const PUSH_INTERVAL_MS = 2000;

const PUSHER_SINK = tronAddressFromEvm("0x000000000000000000000000000000000000dEaD");

/**
 * @param rpcUrl - The HTTP API base URL of the LOCAL TRE
 * @param action - The wait to keep the chain moving for
 * @returns Whatever `action` resolves to
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
