/**
 * Repeat a lookup until it yields a value or the deadline passes, logging and retrying a lookup that throws.
 *
 * @param read - The lookup to repeat
 * @param timeoutMs - How long to keep polling
 * @param intervalMs - The pause between polls
 * @returns The first defined value, or undefined at the deadline
 * @throws {Error} The error of the last lookup, when the lookup at the deadline throws
 */
export async function pollUntilDefined<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let failure: { error: unknown } | undefined;
    try {
      const value = await read();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      console.warn(`poll: read failed, retrying until the deadline (${String(error)})`);
      failure = { error };
    }
    if (Date.now() >= deadline) {
      if (failure !== undefined) {
        throw failure.error;
      }
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
