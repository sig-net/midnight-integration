/**
 * @param read - The lookup to repeat
 * @param timeoutMs - How long to keep polling
 * @param intervalMs - The pause between polls
 * @returns The first defined value, or undefined at the deadline
 */
export async function pollUntilDefined<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await read();
  }
  return value;
}
