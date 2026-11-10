/**
 * A URL with every query parameter value masked, for logs and error
 * messages: a hosted Midnight endpoint carries its access token in the query
 * string (Blockfrost's `project_id`).
 *
 * @param url - The URL to render.
 * @returns The URL with each query value replaced by `REDACTED`, or `url`
 *   unchanged when it has no query string or does not parse as a URL.
 */
export function redactUrlQuery(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (parsed.search === "") return url;
  for (const name of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(name, "REDACTED");
  }
  return parsed.toString();
}
