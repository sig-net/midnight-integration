import type { RemoteWalletMethod } from "./protocol.ts";
import type { RemoteWalletTransport } from "./RemoteWalletClient.ts";

/** Options of {@link createHttpRemoteWalletTransport}. */
export interface HttpRemoteWalletTransportOptions {
  /**
   * Headers sent with every request, e.g. an `authorization` bearer
   * token. Merged over the transport's own `content-type`, so a caller
   * can override that too.
   */
  headers?: Record<string, string>;
}

// Cap how much of a hostile or oversized error page gets quoted into an
// error message.
const ERROR_BODY_LIMIT = 300;

/**
 * The simplest {@link RemoteWalletTransport}: one HTTP POST per call to
 * `<baseUrl>/<method>`, the request and response bodies carrying the
 * encoded payload bytes verbatim (`application/octet-stream`). Runs on
 * global `fetch`, so it works in Node 18+ and browsers with no
 * dependencies. The path carries no protocol version of its own: codec
 * compatibility is already guarded by the handshake's version check, and
 * a host that wants versioned routes puts the version in `baseUrl`
 * (e.g. `https://host/wallet/v1/`).
 *
 * @param baseUrl - Base URL the method name is appended to. A missing
 *   trailing slash is added, so `.../wallet/v1` and `.../wallet/v1/`
 *   both route to `.../wallet/v1/<method>`.
 * @param options - Optional transport tuning, see
 *   {@link HttpRemoteWalletTransportOptions}.
 * @returns A transport for
 *   {@link import("./RemoteWallet.ts").RemoteWallet} or
 *   {@link import("./RemoteWalletClient.ts").RemoteWalletClient}.
 */
export function createHttpRemoteWalletTransport(
  baseUrl: URL,
  options: HttpRemoteWalletTransportOptions = {},
): RemoteWalletTransport {
  const base = baseUrl.href.endsWith("/") ? baseUrl : new URL(`${baseUrl.href}/`);
  return async (method: RemoteWalletMethod, request: Uint8Array): Promise<Uint8Array> => {
    const response = await fetch(new URL(method, base), {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...options.headers },
      body: request,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
      throw new Error(
        `remote wallet host answered ${method} with HTTP ${String(response.status)}` +
          (detail === "" ? "" : `: ${detail}`),
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}
