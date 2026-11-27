// redactUrlQuery: pure string in, string out.

import { describe, expect, it } from "vitest";

import { redactUrlQuery } from "../src/index.ts";

describe("redactUrlQuery", () => {
  interface Case {
    name: string;
    url: string;
    expected: string;
  }
  const CASES: Case[] = [
    {
      name: "masks a Blockfrost project token",
      url: "https://midnight-preprod.blockfrost.io/api/v0?project_id=nightpreprodSecret",
      expected: "https://midnight-preprod.blockfrost.io/api/v0?project_id=REDACTED",
    },
    {
      name: "masks every query value",
      url: "wss://host.example/ws?project_id=secret&other=alsoSecret",
      expected: "wss://host.example/ws?project_id=REDACTED&other=REDACTED",
    },
    {
      name: "returns a URL without a query string unchanged",
      url: "http://127.0.0.1:8088/api/v4/graphql",
      expected: "http://127.0.0.1:8088/api/v4/graphql",
    },
    {
      name: "returns text that is not a URL unchanged",
      url: "not a url",
      expected: "not a url",
    },
  ];

  it.each(CASES)("$name", ({ url, expected }) => {
    expect(redactUrlQuery(url)).toBe(expected);
  });
});
