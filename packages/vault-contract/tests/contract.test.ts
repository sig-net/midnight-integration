// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
} from "@midnight-ntwrk/compact-runtime";

import {
  pureCircuits as signetCircuits,
  readSignetEVMSignatureRequestIndexFromState,
  requestIdHex,
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

// Commitments computed via the COMPILED circuit (task 1.1) — never re-ported.
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);
const OTHER_COMMITMENT = pureCircuits.userCommitment(OTHER_SECRET_KEY);

const VAULT_EVM = bytes(20, 0xee);
const ERC20 = bytes(20, 0xaa);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;

const signetParams = (
  overrides: {
    evmTransaction?: Partial<SignetEVMSignatureRequestParams["evmTransaction"]>;
    mpcRouting?: Partial<SignetEVMSignatureRequestParams["mpcRouting"]>;
  } = {},
): SignetEVMSignatureRequestParams => ({
  evmTransaction: {
    to: ERC20,
    chainId: 11155111n,
    nonce: 0n,
    gasLimit: 100000n,
    maxFeePerGas: 30000000000n,
    maxPriorityFeePerGas: 2000000000n,
    value: 0n,
    ...overrides.evmTransaction,
  },
  mpcRouting: {
    caip2Id: asciiPadded("eip155:11155111", 64),
    keyVersion: 0n,
    path: signetPathOfCommitment(DEPLOYER_COMMITMENT),
    algo: asciiPadded("ecdsa", 32),
    dest: asciiPadded("ethereum", 64),
    params: bytes(512, 0),
    outputSchema: bytes(256, 0x07),
    respondSchema: bytes(256, 0x08),
    ...overrides.mpcRouting,
  },
});

const depositArgs = (overrides: Partial<{ erc20Address: Uint8Array; amount: bigint }> = {}) => ({
  erc20Address: ERC20,
  amount: AMOUNT,
  ...overrides,
});

// ---- Harness ----

const deployContract = (
  deployerCommitment: Uint8Array = DEPLOYER_COMMITMENT,
) => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = contract.initialState(
    createConstructorContext<VaultPrivateState>(
      createVaultPrivateState(SECRET_KEY),
      CPK,
    ),
    deployerCommitment,
  );
  const ctx = createCircuitContext(
    sampleContractAddress(),
    CPK,
    currentContractState,
    currentPrivateState,
  );
  return { contract, ctx };
};

/** Deploy + initialize(VAULT_EVM) as the deployer; returns the ready context. */
const deployInitialized = () => {
  const { contract, ctx } = deployContract();
  const next = contract.circuits.initialize(ctx, VAULT_EVM).context;
  return { contract, ctx: next };
};

const deposit = (
  contract: ReturnType<typeof deployContract>["contract"],
  ctx: CircuitContext<VaultPrivateState>,
  params: SignetEVMSignatureRequestParams = signetParams(),
  args: { erc20Address: Uint8Array; amount: bigint } = depositArgs(),
) => contract.circuits.deposit(ctx, params, args);

// ---- Tests ----

describe("erc20-vault ledger shape", () => {
  it("signetRequestsIndex parses into the shared signet-midnight types", () => {
    const { ctx } = deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerIndex: SignetEVMSignatureRequestLedgerIndex = ledger(
      ctx.currentQueryContext.state,
    ).signetRequestsIndex;

    expect(ledgerIndex.isEmpty()).toBe(true);
    expect(toSignetEVMSignatureRequestIndex(ledgerIndex).size).toBe(0);
  });

  it("MPC-style: finds the request index in RAW state by position, no ledger()", () => {
    const { ctx } = deployContract();

    const rawState = ctx.currentQueryContext.state;
    const node = signetFieldNode(rawState, SIGNET_REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    const rawIndex = readSignetEVMSignatureRequestIndexFromState(rawState);
    const typedIndex = toSignetEVMSignatureRequestIndex(
      ledger(ctx.currentQueryContext.state).signetRequestsIndex,
    );
    expect(rawIndex).toEqual(typedIndex);
    expect(rawIndex.size).toBe(0);
  });
});

describe("userCommitment (task 1.1)", () => {
  it("computes a 32-byte commitment off-chain via the compiled circuit", () => {
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
  it("is deployer-gated", () => {
    // Deployed with a stranger's commitment; our caller key can't initialize.
    const { contract, ctx } = deployContract(OTHER_COMMITMENT);
    expect(() => contract.circuits.initialize(ctx, VAULT_EVM)).toThrow(
      /Not the deployer/,
    );
  });

  it("is one-shot", () => {
    const { contract, ctx } = deployInitialized();
    expect(() => contract.circuits.initialize(ctx, VAULT_EVM)).toThrow(
      /Already initialized/,
    );
  });

  it("stores the vault EVM address", () => {
    const { ctx } = deployInitialized();
    expect(ledger(ctx.currentQueryContext.state).vaultEvmAddress).toEqual(
      VAULT_EVM,
    );
  });
});

describe("deposit round-trip (task 1.2)", () => {
  it("stores the request readable identically via ledger(), the shared parser, and the RAW reader", () => {
    const { contract, ctx } = deployInitialized();
    const params = signetParams();

    const next = deposit(contract, ctx, params).context;
    const state = next.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignetEVMSignatureRequestIndex(
      ledger(state).signetRequestsIndex,
    );
    // Read 2: MPC-style raw read — no compiled contract involved.
    const rawIndex = readSignetEVMSignatureRequestIndexFromState(state);

    expect(typedIndex.size).toBe(1);
    expect(rawIndex).toEqual(typedIndex);

    const [idHex, record] = [...typedIndex.entries()][0];

    // Caller-supplied parts come back verbatim.
    expect(record.evmTransaction).toEqual(params.evmTransaction);
    expect(record.mpcRouting).toEqual(params.mpcRouting);
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(vaultEvmAddress, amount).
    expect(new TextDecoder().decode(record.calldata.funcSig).replace(/\0+$/, "")).toBe(
      "transfer(address,uint256)",
    );
    expect(record.calldata.argCount).toBe(2n);
    const expectedArg0 = new Uint8Array(32);
    expectedArg0.set(VAULT_EVM); // Bytes<20> as Field as Bytes<32> = LE embed
    expect(record.calldata.args[0]).toEqual(expectedArg0);
    expect(bytesToBigintLE(record.calldata.args[1])).toBe(AMOUNT);
    expect(record.calldata.args[2]).toEqual(new Uint8Array(32));
    expect(record.calldata.args[3]).toEqual(new Uint8Array(32));

    // The map key IS the domain-separated hash of the record — recomputed
    // off-chain with the compiled library circuit.
    expect(idHex).toBe(
      requestIdHex(signetCircuits.signetEVMSignatureRequestId(record)),
    );

    // Nonce bumped for the next request.
    expect(ledger(state).signetNonce).toBe(1n);
  });
});

describe("deposit validation (task 1.3)", () => {
  it("rejects before initialize", () => {
    const { contract, ctx } = deployContract();
    expect(() => deposit(contract, ctx)).toThrow(/Not initialized/);
  });

  it("rejects a zero ERC20 address", () => {
    const { contract, ctx } = deployInitialized();
    const zero = new Uint8Array(20);
    expect(() =>
      deposit(
        contract,
        ctx,
        signetParams({ evmTransaction: { to: zero } }),
        depositArgs({ erc20Address: zero }),
      ),
    ).toThrow(/ERC20 address cannot be zero/);
  });

  it("rejects a zero amount", () => {
    const { contract, ctx } = deployInitialized();
    expect(() =>
      deposit(contract, ctx, signetParams(), depositArgs({ amount: 0n })),
    ).toThrow(/Amount must be positive/);
  });

  it("rejects amounts above Uint<64> max (unclaimable)", () => {
    const { contract, ctx } = deployInitialized();
    expect(() =>
      deposit(
        contract,
        ctx,
        signetParams(),
        depositArgs({ amount: UINT64_MAX + 1n }),
      ),
    ).toThrow(/Amount exceeds Uint<64> max/);
  });

  it("rejects when the EVM 'to' is not the ERC20 contract", () => {
    const { contract, ctx } = deployInitialized();
    expect(() =>
      deposit(
        contract,
        ctx,
        signetParams({ evmTransaction: { to: bytes(20, 0xbb) } }),
      ),
    ).toThrow(/EVM 'to' must be the ERC20 contract/);
  });

  it("rejects a nonzero ETH value", () => {
    const { contract, ctx } = deployInitialized();
    expect(() =>
      deposit(contract, ctx, signetParams({ evmTransaction: { value: 1n } })),
    ).toThrow(/No ETH value for ERC20 transfer/);
  });

  it("rejects a zero chain id", () => {
    const { contract, ctx } = deployInitialized();
    expect(() =>
      deposit(contract, ctx, signetParams({ evmTransaction: { chainId: 0n } })),
    ).toThrow(/Chain ID must be positive/);
  });

  it("rejects a zero gas limit", () => {
    const { contract, ctx } = deployInitialized();
    expect(() =>
      deposit(
        contract,
        ctx,
        signetParams({ evmTransaction: { gasLimit: 0n } }),
      ),
    ).toThrow(/Gas limit must be positive/);
  });

  it("rejects a path bound to someone else's identity", () => {
    const { contract, ctx } = deployInitialized();
    expect(() =>
      deposit(
        contract,
        ctx,
        signetParams({
          mpcRouting: { path: signetPathOfCommitment(OTHER_COMMITMENT) },
        }),
      ),
    ).toThrow(/path hex does not match commitment/);
  });

  it("rejects a path with garbage after the hex", () => {
    const { contract, ctx } = deployInitialized();
    const dirty = signetPathOfCommitment(DEPLOYER_COMMITMENT);
    dirty[200] = 0x41;
    expect(() =>
      deposit(contract, ctx, signetParams({ mpcRouting: { path: dirty } })),
    ).toThrow(/zero-padded/);
  });

  it("identical deposits get DISTINCT ids — requestNonce differentiates them", () => {
    // The dedup assert (!member) is a belt-and-braces invariant: it cannot
    // trip in the normal flow because the nonce is part of the hashed record,
    // so an identical resubmission is a NEW request. Document that here.
    const { contract, ctx } = deployInitialized();
    const params = signetParams();

    const afterFirst = deposit(contract, ctx, params).context;
    const afterSecond = deposit(contract, afterFirst, params).context;

    const index = toSignetEVMSignatureRequestIndex(
      ledger(afterSecond.currentQueryContext.state).signetRequestsIndex,
    );
    expect(index.size).toBe(2);
    const nonces = [...index.values()].map((r) => r.requestNonce).sort();
    expect(nonces).toEqual([0n, 1n]);
  });
});
