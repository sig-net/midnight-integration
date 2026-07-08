// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  deriveJubjubKeypair,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  requestIdHex,
  signetEVMSignatureRequestId,
  signetFieldNode,
  signetPathOfCommitment,
  toSignetEVMSignatureRequestIndex,
  SIGNET_REQUESTS_INDEX_FIELD,
  type SignetEVMSignatureRequestLedgerIndex,
  type SignetEVMSignatureRequestParams,
} from "@midnight-erc20-vault/signet-midnight";

import {
  Contract,
  createVaultPrivateState,
  ledger,
  pureCircuits,
  witnesses,
  type VaultPrivateState,
} from "../src/index.ts";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);

/** Zero-padded ASCII bytes, the Compact `pad(N, "text")` convention. */
const asciiPadded = (text: string, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  out.set(new TextEncoder().encode(text));
  return out;
};

/** Little-endian bigint of a byte array (Compact field<->bytes convention). */
const bytesToBigintLE = (b: Uint8Array): bigint => {
  let result = 0n;
  for (let i = b.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(b[i]);
  }
  return result;
};

// Identity secrets for the simulated deployer/caller (same key: the deployer
// deposits in these tests) and for a stranger.
const SECRET_KEY = bytes(32, 7);
const OTHER_SECRET_KEY = bytes(32, 8);

// Commitments computed via the COMPILED circuit
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);
const OTHER_COMMITMENT = pureCircuits.userCommitment(OTHER_SECRET_KEY);

// The "MPC" of these tests: its attestation key is pinned by the constructor.
const MPC_KEYS = deriveJubjubKeypair(bytes(32, 0x42));

const VAULT_EVM = bytes(20, 0xee);
const ERC20 = bytes(20, 0xaa);
const ZERO_ADDRESS = new Uint8Array(20);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;

/**
 * Known-good signet params for a deposit — the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread
 * of this base with the delta inline (see {@link DEPOSIT_REJECTION_CASES}).
 */
const VALID_PARAMS: SignetEVMSignatureRequestParams = {
  evmTransaction: {
    to: ERC20,
    chainId: 11155111n,
    nonce: 0n,
    gasLimit: 100000n,
    maxFeePerGas: 30000000000n,
    maxPriorityFeePerGas: 2000000000n,
    value: 0n,
  },
  mpcRouting: {
    caip2Id: asciiPadded("eip155:11155111", 32),
    keyVersion: 1n,
    path: signetPathOfCommitment(DEPLOYER_COMMITMENT),
    algo: asciiPadded("ecdsa", 32),
    dest: asciiPadded("ethereum", 32),
    params: bytes(64, 0),
    outputDeserializationSchema: bytes(128, 0x07),
    respondSerializationSchema: bytes(128, 0x08),
  },
};

/**
 * The deposit circuit's `DepositRequest` struct argument. The compact compiler
 * inlines the struct type anonymously into the generated circuit signature;
 * this named interface matches it structurally.
 */
interface DepositArgs {
  erc20Address: Uint8Array;
  amount: bigint;
}

/**
 * Known-good deposit request args — the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread.
 */
const VALID_ARGS: DepositArgs = {
  erc20Address: ERC20,
  amount: AMOUNT,
};

// ---- Harness ----

const deployContract = async (
  deployerCommitment: Uint8Array = DEPLOYER_COMMITMENT,
) => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } =
    await contract.initialState(
      createConstructorContext<VaultPrivateState>(
        createVaultPrivateState(SECRET_KEY),
        CPK,
      ),
      deployerCommitment,
      MPC_KEYS.pk,
    );
  const ctx = createCircuitContext(
    "requestDeposit",
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

/** Deploy + initialize(VAULT_EVM) as the deployer; returns the ready context. */
const deployInitialized = async () => {
  const { contract, ctx } = await deployContract();
  const next = (await contract.circuits.initialize(ctx, VAULT_EVM)).context;
  return { contract, ctx: next };
};

// ---- Tests ----

describe("erc20-vault ledger shape", () => {
  it("signetRequestsIndex parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerIndex: SignetEVMSignatureRequestLedgerIndex = ledger(
      ctx.callContext.currentQueryContext.state,
    ).signetRequestsIndex;

    expect(ledgerIndex.isEmpty()).toBe(true);
    expect(toSignetEVMSignatureRequestIndex(ledgerIndex).size).toBe(0);
  });

  it("MPC-style: finds the request index in RAW state by position, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    const node = signetFieldNode(rawState, SIGNET_REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(rawState);
    const typedIndex = toSignetEVMSignatureRequestIndex(
      ledger(ctx.callContext.currentQueryContext.state).signetRequestsIndex,
    );
    expect(requestsIndex).toEqual(typedIndex);
    expect(requestsIndex.size).toBe(0);
    expect(nonce).toBe(0n);
  });
});

describe("userCommitment", () => {
  it("check 32-byte commitments computed off-chain via the compiled circuit", () => {
    expect(DEPLOYER_COMMITMENT).toHaveLength(32);
    expect(DEPLOYER_COMMITMENT).not.toEqual(new Uint8Array(32));
    expect(DEPLOYER_COMMITMENT).not.toEqual(OTHER_COMMITMENT);
  });

  it("builds a contract-accepted path from the commitment", () => {
    const path = signetPathOfCommitment(DEPLOYER_COMMITMENT);
    expect(path).toHaveLength(256);
    // First 64 bytes: lowercase hex of the commitment; rest zero.
    expect(new TextDecoder().decode(path.slice(0, 64))).toBe(
      requestIdHex(DEPLOYER_COMMITMENT),
    );
    expect(path.slice(64)).toEqual(new Uint8Array(192));
    // The compiled library circuit accepts it (same logic the contract proves).
    expect(() =>
      signetCircuits.assertPathCommitment(DEPLOYER_COMMITMENT, path),
    ).not.toThrow();
  });
});

describe("initialize", () => {
  it("is deployer-gated", async () => {
    // Deployed with a stranger's commitment; our caller key can't initialize.
    const { contract, ctx } = await deployContract(OTHER_COMMITMENT);
    await expect(contract.circuits.initialize(ctx, VAULT_EVM)).rejects.toThrow(
      /Not the deployer/,
    );
  });

  it("is one-shot", async () => {
    const { contract, ctx } = await deployInitialized();
    await expect(contract.circuits.initialize(ctx, VAULT_EVM)).rejects.toThrow(
      /Already initialized/,
    );
  });

  it("stores the vault EVM address", async () => {
    const { ctx } = await deployInitialized();
    expect(
      ledger(ctx.callContext.currentQueryContext.state).vaultEvmAddress,
    ).toEqual(VAULT_EVM);
  });
});

describe("deposit round-trip", () => {
  it("stores the request readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployInitialized();

    const next = (
      await contract.circuits.requestDeposit(ctx, VALID_PARAMS, VALID_ARGS)
    ).context;
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignetEVMSignatureRequestIndex(
      ledger(state).signetRequestsIndex,
    );
    // Read 2: MPC-style raw read — no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(state);

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    // The raw counter read matches the generated one.
    expect(rawLedger.nonce).toBe(ledger(state).signetNonce);

    const [idHex, record] = [...typedIndex.entries()][0];

    // Caller-supplied parts come back verbatim.
    expect(record.evmTransaction).toEqual(VALID_PARAMS.evmTransaction);
    expect(record.mpcRouting).toEqual(VALID_PARAMS.mpcRouting);
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(vaultEvmAddress, amount).
    expect(new TextDecoder().decode(record.calldata.funcSig).replace(/\0+$/, "")).toBe(
      "transfer(address,uint256)",
    );
    expect(record.calldata.argCount).toBe(2n);
    // EVMCalldata<2>: exactly the two transfer(address,uint256) arg slots.
    expect(record.calldata.args).toHaveLength(2);
    const expectedArg0 = new Uint8Array(32);
    expectedArg0.set(VAULT_EVM); // Bytes<20> as Field as Bytes<32> = LE embed
    expect(record.calldata.args[0]).toEqual(expectedArg0);
    expect(bytesToBigintLE(record.calldata.args[1])).toBe(AMOUNT);

    // The map key IS the domain-separated hash of the record — recomputed
    // off-chain with the library's TS twin of the request-id circuit. This
    // assertion is the lockstep check the twin's deviation note relies on:
    // the id computed in TS must equal the key the REAL compiled contract
    // minted in-circuit.
    expect(idHex).toBe(requestIdHex(signetEVMSignatureRequestId(record)));

    // Nonce bumped for the next request.
    expect(ledger(state).signetNonce).toBe(1n);
  });
});

// Paths for the rejection table below: one bound to the wrong identity, and
// one with garbage after the commitment hex (the contract requires the rest
// of the path to be zero-padded).
const OTHER_PATH = signetPathOfCommitment(OTHER_COMMITMENT);
const DIRTY_PATH = signetPathOfCommitment(DEPLOYER_COMMITMENT);
DIRTY_PATH[200] = 0x41;

/** One row of the deposit rejection table: full inputs → expected error. */
interface DepositRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete signet params passed to the circuit. */
  params: SignetEVMSignatureRequestParams;
  /** Complete deposit request args passed to the circuit. */
  args: DepositArgs;
  /** Error the circuit must throw. */
  throws: RegExp;
}

const DEPOSIT_REJECTION_CASES: DepositRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    params: {
      ...VALID_PARAMS,
      evmTransaction: { ...VALID_PARAMS.evmTransaction, to: ZERO_ADDRESS },
    },
    args: { ...VALID_ARGS, erc20Address: ZERO_ADDRESS },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero amount",
    params: VALID_PARAMS,
    args: { ...VALID_ARGS, amount: 0n },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unclaimable)",
    params: VALID_PARAMS,
    args: { ...VALID_ARGS, amount: UINT64_MAX + 1n },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "an EVM 'to' that is not the ERC20 contract",
    params: {
      ...VALID_PARAMS,
      evmTransaction: { ...VALID_PARAMS.evmTransaction, to: bytes(20, 0xbb) },
    },
    args: VALID_ARGS,
    throws: /EVM 'to' must be the ERC20 contract/,
  },
  {
    name: "a nonzero ETH value",
    params: {
      ...VALID_PARAMS,
      evmTransaction: { ...VALID_PARAMS.evmTransaction, value: 1n },
    },
    args: VALID_ARGS,
    throws: /No ETH value for ERC20 transfer/,
  },
  {
    name: "a zero chain id",
    params: {
      ...VALID_PARAMS,
      evmTransaction: { ...VALID_PARAMS.evmTransaction, chainId: 0n },
    },
    args: VALID_ARGS,
    throws: /Chain ID must be positive/,
  },
  {
    name: "a zero gas limit",
    params: {
      ...VALID_PARAMS,
      evmTransaction: { ...VALID_PARAMS.evmTransaction, gasLimit: 0n },
    },
    args: VALID_ARGS,
    throws: /Gas limit must be positive/,
  },
  {
    name: "a path bound to someone else's identity",
    params: {
      ...VALID_PARAMS,
      mpcRouting: { ...VALID_PARAMS.mpcRouting, path: OTHER_PATH },
    },
    args: VALID_ARGS,
    throws: /path hex does not match commitment/,
  },
  {
    name: "a path with garbage after the hex",
    params: {
      ...VALID_PARAMS,
      mpcRouting: { ...VALID_PARAMS.mpcRouting, path: DIRTY_PATH },
    },
    args: VALID_ARGS,
    throws: /zero-padded/,
  },
  {
    name: "the legacy key version 0",
    params: {
      ...VALID_PARAMS,
      mpcRouting: { ...VALID_PARAMS.mpcRouting, keyVersion: 0n },
    },
    args: VALID_ARGS,
    throws: /keyVersion must be >= 1/,
  },
];

describe("deposit validation", () => {
  it.each(DEPOSIT_REJECTION_CASES)(
    "rejects $name",
    async ({ params, args, throws }) => {
      const { contract, ctx } = await deployInitialized();
      await expect(
        contract.circuits.requestDeposit(ctx, params, args),
      ).rejects.toThrow(throws);
    },
  );

  it("rejects before initialize", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.requestDeposit(ctx, VALID_PARAMS, VALID_ARGS),
    ).rejects.toThrow(/Not initialized/);
  });

  it("identical deposits get DISTINCT ids — requestNonce differentiates them", async () => {
    // The dedup assert (!member) is a belt-and-braces invariant: it cannot
    // trip in the normal flow because the nonce is part of the hashed record,
    // so an identical resubmission is a NEW request. Document that here.
    const { contract, ctx } = await deployInitialized();

    const afterFirst = (
      await contract.circuits.requestDeposit(ctx, VALID_PARAMS, VALID_ARGS)
    ).context;
    const afterSecond = (
      await contract.circuits.requestDeposit(
        afterFirst,
        VALID_PARAMS,
        VALID_ARGS,
      )
    ).context;

    const index = toSignetEVMSignatureRequestIndex(
      ledger(afterSecond.callContext.currentQueryContext.state)
        .signetRequestsIndex,
    );
    expect(index.size).toBe(2);
    const nonces = [...index.values()].map((r) => r.requestNonce).sort();
    expect(nonces).toEqual([0n, 1n]);
  });
});
