import fs from "node:fs";
import readline from "node:readline/promises";

/**
 * Block until the operator hits Enter in the terminal, for step-through runs.
 * Input is read from `/dev/tty` directly because vitest runs tests in
 * workers, where `process.stdin` is not attached to the real terminal.
 * Output goes through console.log — NOT the tty — because vitest's live
 * reporter redraws its summary block in place and erases direct tty writes;
 * console output is coordinated with the reporter and survives.
 * Crashes loudly if there is no TTY — this is only ever called when the
 * operator explicitly opts into step-through mode at an interactive terminal.
 */
export async function waitForGo(
    index: number,
    total: number,
    name: string,
): Promise<void> {
  const ttyReadStream = fs.createReadStream("/dev/tty", { encoding: "utf8" });
  const rl = readline.createInterface({ input: ttyReadStream });

  try {
    console.log(
      `\n${"━".repeat(72)}\n⏸️   PAUSED (step through mode active)\n▶️    Hit enter to run next test:\n▶  TEST ${index}/${total} "${name}".`,
    );
    await rl.question("");
  } finally {
    // rl.close() alone leaves the /dev/tty handle open, which keeps the
    // worker's event loop alive and hangs vitest at exit.
    rl.close();
    ttyReadStream.destroy();
  }
}
