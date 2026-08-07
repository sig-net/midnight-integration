// Environment-variable reading shared by the config resolvers. A variable set
// to whitespace or the empty string means UNSET everywhere in this workspace,
// so every reader funnels through here rather than relying on `||`'s
// falsiness, which cannot say whether "" was intended.

/**
 * Read an environment variable, treating blank as unset.
 *
 * Pairs with `??` at the call site: `envOrUndefined(env, "X") ?? fallback`
 * falls through for a missing AND for a blank variable, which `env.X ?? y`
 * would not.
 *
 * @param env - The environment to read.
 * @param name - The variable to read.
 * @returns The trimmed value, or undefined when unset or blank.
 */
export function envOrUndefined(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Narrow a possibly-blank string to undefined, for values already read out of
 * the environment. The non-lookup counterpart of {@link envOrUndefined}.
 *
 * @param value - The raw value, possibly blank or absent.
 * @returns The trimmed value, or undefined when absent or blank.
 */
export function blankAsUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
