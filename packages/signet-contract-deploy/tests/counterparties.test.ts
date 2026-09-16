// The counterparty resolvers: environment over published, canonicalised,
// disagreement refused. Pure: no network.

import { getMpcRootPublicKey, getSignetContractAddress, MidnightNetwork } from "@sig-net/midnight";
import { describe, expect, it } from "vitest";

import {
  CounterpartyOrigin,
  findMpcRootPublicKey,
  findSignetContractAddress,
  type ResolvedCounterparty,
  resolveMpcRootPublicKey,
  resolveSignetContractAddress,
} from "../src/index.ts";

const STAGENET_SIGNET = getSignetContractAddress(MidnightNetwork.Stagenet);
const STAGENET_MPC_KEY = getMpcRootPublicKey(MidnightNetwork.Stagenet);
const STAGENET_MPC_KEY_NEAR_FORM =
  "secp256k1:3Ww8iFjqTHufye5aRGUvrQqETegR4gVUcW8FX5xzscaN9ENhpkffojsxJwi6N1RbbHMTxYa9UyKeqK3fsMuwxjR5";
const OTHER_KEY_COMPRESSED = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** One environment and what a resolver must make of it. */
interface ResolutionCase {
  readonly name: string;
  readonly env: Record<string, string | undefined>;
  /** The resolution, or undefined when neither source supplies a value. */
  readonly found: ResolvedCounterparty | undefined;
}

/** One environment a resolver must refuse. */
interface RefusedCase {
  readonly name: string;
  readonly env: Record<string, string | undefined>;
  readonly error: RegExp;
}

describe("findSignetContractAddress / resolveSignetContractAddress", () => {
  const FOUND: readonly ResolutionCase[] = [
    {
      name: "the published singleton on a deployed network with nothing set",
      env: { NETWORK_ID: "stagenet" },
      found: { value: STAGENET_SIGNET, origin: CounterpartyOrigin.Published },
    },
    {
      name: "a set value agreeing with the published one, canonicalised",
      env: {
        NETWORK_ID: "stagenet",
        MIDNIGHT_SIGNET_CONTRACT_ADDRESS: `0x${STAGENET_SIGNET.toUpperCase()}`,
      },
      found: { value: STAGENET_SIGNET, origin: CounterpartyOrigin.Environment },
    },
    {
      name: "a set value on the local stack, which publishes nothing",
      env: { NETWORK_ID: "undeployed", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "ab".repeat(32) },
      found: { value: "ab".repeat(32), origin: CounterpartyOrigin.Environment },
    },
    {
      name: "a set value on a deployed network the SDK publishes nothing for yet",
      env: { NETWORK_ID: "preview", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "cd".repeat(32) },
      found: { value: "cd".repeat(32), origin: CounterpartyOrigin.Environment },
    },
    {
      name: "nothing on the local stack",
      env: { NETWORK_ID: "undeployed" },
      found: undefined,
    },
    {
      name: "a blank value on the local stack",
      env: { NETWORK_ID: "undeployed", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "  " },
      found: undefined,
    },
  ];

  it.each(FOUND)("finds $name", ({ env, found }) => {
    expect(findSignetContractAddress(env)).toEqual(found);
  });

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "a set value disagreeing with the published singleton",
      env: { NETWORK_ID: "stagenet", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "ab".repeat(32) },
      error: /disagrees with the signet singleton the SDK publishes for "stagenet"/,
    },
    {
      name: "a malformed address",
      env: { NETWORK_ID: "stagenet", MIDNIGHT_SIGNET_CONTRACT_ADDRESS: "0xabc" },
      error: /not a 32-byte contract address/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ env, error }) => {
    expect(() => findSignetContractAddress(env)).toThrow(error);
    expect(() => resolveSignetContractAddress(env)).toThrow(error);
  });

  const UNRESOLVABLE: readonly RefusedCase[] = [
    {
      name: "nothing on the local stack",
      env: { NETWORK_ID: "undeployed" },
      error: /required on "undeployed": deploy one with deploySignetContract/,
    },
    {
      name: "nothing on a deployed network the SDK publishes nothing for yet",
      env: { NETWORK_ID: "preview" },
      error: /required on "preview": the SDK publishes no signet singleton for it yet/,
    },
  ];

  it.each(UNRESOLVABLE)("resolve fails on $name", ({ env, error }) => {
    expect(() => resolveSignetContractAddress(env)).toThrow(error);
  });
});

describe("findMpcRootPublicKey / resolveMpcRootPublicKey", () => {
  const FOUND: readonly ResolutionCase[] = [
    {
      name: "the published key on a deployed network with nothing set",
      env: { NETWORK_ID: "stagenet" },
      found: { value: STAGENET_MPC_KEY, origin: CounterpartyOrigin.Published },
    },
    {
      name: "the NEAR spelling of the published key, canonicalised",
      env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: STAGENET_MPC_KEY_NEAR_FORM },
      found: { value: STAGENET_MPC_KEY, origin: CounterpartyOrigin.Environment },
    },
    {
      name: "a compressed key on the local stack, canonicalised",
      env: { NETWORK_ID: "undeployed", MPC_SECP256K1_PUBKEY: OTHER_KEY_COMPRESSED },
      found: {
        value:
          "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
          "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
        origin: CounterpartyOrigin.Environment,
      },
    },
    {
      name: "nothing on the local stack",
      env: { NETWORK_ID: "undeployed" },
      found: undefined,
    },
  ];

  it.each(FOUND)("finds $name", ({ env, found }) => {
    expect(findMpcRootPublicKey(env)).toEqual(found);
  });

  const REFUSED: readonly RefusedCase[] = [
    {
      name: "a set key disagreeing with the published one",
      env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: OTHER_KEY_COMPRESSED },
      error: /disagrees with the MPC root public key the SDK publishes for "stagenet"/,
    },
    {
      name: "something that is not a public key",
      env: { NETWORK_ID: "stagenet", MPC_SECP256K1_PUBKEY: "0x04ab" },
      error: /not a secp256k1 public key/,
    },
  ];

  it.each(REFUSED)("refuses $name", ({ env, error }) => {
    expect(() => findMpcRootPublicKey(env)).toThrow(error);
    expect(() => resolveMpcRootPublicKey(env)).toThrow(error);
  });

  it("resolve fails on the local stack with nothing set", () => {
    expect(() => resolveMpcRootPublicKey({ NETWORK_ID: "undeployed" })).toThrow(
      /MPC_SECP256K1_PUBKEY is required on "undeployed": set it to the root public key/,
    );
  });
});
