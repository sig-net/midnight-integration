import { compactSerialize } from "@sig-net/midnight-serde";
import { expect, it } from "vitest";

import { pureCircuits } from "../managed/contract/index.js";
import { fixtureIdentity } from "../src/toolchain.ts";

it("checks both circuit directions for 1000 u128 response values", () => {
  expect(fixtureIdentity().release).toBe("0.33.0-rc.2");
  let amount = 1n;
  for (let i = 0; i < 1000; i++) {
    amount = (amount * 6364136223846793005n + 1442695040888963407n) % (1n << 128n);
    const value = { ok: i % 2 === 0, amount };
    const schema = { struct: { ok: "bool", amount: "u128" } };
    const bytes = compactSerialize(schema, value);
    expect(bytes).toEqual(pureCircuits.serResult(value));
    expect(pureCircuits.deResult(bytes)).toEqual(value);
  }
});
