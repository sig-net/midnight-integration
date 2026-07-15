// Subprocess plumbing for pipeline steps that must shell out (the compact
// compiler and docker compose are external CLIs). Deploys and circuit calls
// are in-process imports — only the compile and fakenet-responder steps
// should need this.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (where the workspace's root scripts live). */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Run a root-level package script (`yarn run <script>` at {@link REPO_ROOT}),
 * streaming its output live to the console and capturing stdout.
 *
 * @param script - Name of the root package.json script (e.g. `compile:vault-contract:zk`).
 * @param env - Full environment for the child process (pass the suite's env
 *   accumulator, not `process.env`).
 * @param timeoutMs - Kill the child and fail after this many milliseconds.
 * @returns The captured stdout.
 * @throws If the script exits non-zero, is killed by a signal, or times out;
 *   the error message includes the tail of the combined output.
 */
export async function runRootScript(
  script: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string> {
  return await runCommand("yarn", ["run", script], env, timeoutMs);
}

/**
 * Run an arbitrary command at {@link REPO_ROOT}, streaming its output live
 * to the console and capturing stdout. {@link runRootScript} is the yarn
 * specialization of this.
 *
 * @param command - The executable to spawn (e.g. `docker`).
 * @param args - Arguments passed verbatim (no shell interpretation).
 * @param env - Full environment for the child process (pass the suite's env
 *   accumulator, not `process.env`).
 * @param timeoutMs - Kill the child and fail after this many milliseconds.
 * @returns The captured stdout.
 * @throws If the command exits non-zero, is killed by a signal, or times
 *   out; the error message includes the tail of the combined output.
 */
export async function runCommand(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let combined = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      combined += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      combined += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = combined.split("\n").slice(-20).join("\n");
      reject(
        new Error(
          `${command} ${args.join(" ")} ${signal ? `killed by ${signal} (timeout ${timeoutMs}ms?)` : `exited with code ${code}`}\n--- output tail ---\n${tail}`,
        ),
      );
    });
  });
}
