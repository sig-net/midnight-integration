// Environment preflight checks: is the local Midnight stack up, is the
// compact compiler installed. Pure reachability probes — no protocol traffic.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Assert an HTTP endpoint is reachable. ANY http response counts as
 * reachable (the indexer's GraphQL endpoint answers GETs with 400, the
 * proof server's root with 404 — both prove the service is up); only a
 * network-level failure (refused, unresolvable, timeout) fails.
 *
 * @param name - Human-readable service name for the error message.
 * @param url - The endpoint to probe.
 * @throws If the request cannot reach the service at all, with a hint to
 *   start the docker stack.
 */
export async function assertHttpReachable(name: string, url: string): Promise<void> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(
      `${name} is not reachable at ${url} — is the local Midnight stack up? Start it with \`docker compose up -d\` at the repo root. (${String(error)})`,
      { cause: error },
    );
  }
}

/**
 * Assert an executable is on PATH and runs, by executing it once.
 *
 * @param command - The executable name (e.g. `compact`).
 * @param args - Arguments for a cheap invocation (e.g. `["--version"]`).
 * @throws If the command is missing or exits non-zero, with install hint.
 */
export async function assertCommandAvailable(command: string, args: string[]): Promise<void> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 30_000 });
    console.log(`${command} ${args.join(" ")}: ${stdout.trim().split("\n")[0]}`);
  } catch (error) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` failed — is the ${command} toolchain installed and on PATH? (${String(error)})`,
      { cause: error },
    );
  }
}
