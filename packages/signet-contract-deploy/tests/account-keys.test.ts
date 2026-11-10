import { describe, expect, it } from "vitest";

import { deriveAccountKeys, deriveAddresses } from "../src/plumbing/wallet.ts";

describe("deriveAccountKeys", () => {
  it("derives each role's key from that role's seed, so a wallet's addresses stay fixed", () => {
    const keys = deriveAccountKeys("01".repeat(32), "undeployed");
    expect(deriveAddresses(keys, "undeployed")).toEqual({
      unshielded: "mn_addr_undeployed13gn5semyxq8w3cd9fv0av5v4crkzcfmt7mlmvh83wwu6gtc8w3squ0ry2t",
      shielded:
        "mn_shield-addr_undeployed1aympv4ge4mj42qmd6sf44jl6tx5q4c8d2wa77wzllxqm0tzf9dj09crt9qxgwf8ha0zh535nnmg97v0ahgwzse5pptkan2e075yeg8g0r7c3k",
      dust: "mn_dust_undeployed1w0ytyyymvswknfjfghxqw54ajkm8xur5q83tjnna3ydyygqvvpy467fhldw",
    });
  });
});
