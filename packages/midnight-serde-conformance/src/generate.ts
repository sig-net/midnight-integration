import { writeFileSync } from "node:fs";

import { CASES } from "./cases.ts";
import { fixtureIdentity } from "./toolchain.ts";

fixtureIdentity();
const records = CASES.map(({ name, value, bytes }) => ({
  name,
  value,
  hex: Buffer.from(bytes).toString("hex"),
}));
writeFileSync(
  new URL("../corpus/borsh-corpus.json", import.meta.url),
  JSON.stringify(
    records,
    (_key, value: object | string | number | bigint | boolean | null) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  ) + "\n",
);
