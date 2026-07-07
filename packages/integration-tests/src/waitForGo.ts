import fs from "node:fs";

/**
 * Block until the operator hits Enter in the terminal, for step-through runs.
 * Input is read from `/dev/tty` directly because vitest runs tests in
 * workers, where `process.stdin` is not attached to the real terminal.
 * Output goes through console.log — NOT the tty — because vitest's live
 * reporter redraws its summary block in place and erases direct tty writes;
 * console output is coordinated with the reporter and survives.
 *
 * The read is synchronous and byte-by-byte on purpose. A streaming reader
 * (fs.createReadStream + readline) eagerly queues a second blocking read(2)
 * on the tty right after delivering the first line; destroy() cannot cancel
 * that in-flight threadpool read, and the orphaned reader swallows the next
 * Enter keypress — making every later pause require two Enters. readSync up
 * to the newline consumes exactly one line and leaves nothing in flight.
 * Crashes loudly if there is no TTY — this is only ever called when the
 * operator explicitly opts into step-through mode at an interactive terminal.
 */
export async function waitForGo(
    index: number,
    total: number,
    name: string,
): Promise<void> {
  console.log(
    `\n${"━".repeat(72)}\n⏸️   PAUSED (step through mode active)\n▶️    Hit enter to run next test:\n▶  TEST ${index}/${total} "${name}".`,
  );

  const fd = fs.openSync("/dev/tty", "r");
  try {
    const byte = Buffer.alloc(1);
    // Canonical tty mode: the first readSync blocks until a full line is
    // entered, then the line's bytes drain one readSync at a time.
    while (fs.readSync(fd, byte, 0, 1, null) > 0 && byte[0] !== 0x0a) {
      /* drain until newline */
    }
  } finally {
    fs.closeSync(fd);
  }
}
