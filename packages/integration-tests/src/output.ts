// Console output helpers shared by globalSetup and the flow test files.
// This module MUST stay free of `vitest` imports: it is loaded by globalSetup
// in vitest's main process, where the worker-only test APIs are unavailable.

/** Loud, uniform skip line so skipped steps are obvious in the output. */
export function logSkip(step: string, reason: string): void {
  console.log(`SKIPPED: ${step} — ${reason}`);
}

/** Print a value the operator must save, too loud to miss. */
export function banner(lines: string[]): void {
  const border = "=".repeat(72);
  console.log(`\n${border}\n${lines.join("\n")}\n${border}\n`);
}

/**
 * Print a bold header at the start of each setup step / flow test. We run
 * with `--disable-console-intercept` (so subprocess output streams live),
 * which means vitest does NOT prefix logs with their test name — this header
 * is what segments the streaming output and shows which step is currently
 * running. A heavy rule (`━`) distinguishes step boundaries from value
 * banners (`=`).
 */
export function testHeader(index: number, total: number, name: string): void {
  const border = "━".repeat(72);
  console.log(`\n${border}\n▶  TEST ${index}/${total}  ${name}\n${border}`);
}
