// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  ABIWordKind,
  ERC20_TRANSFER_SELECTOR,
  calculateRequestId,
  deriveJubjubKeypair,
  evmAddressAbiWord,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  requestIdHex,
  signetFieldNode,
  signetPathOfCommitment,
  toSignBidirectionalEventIndex,
  SIGNET_REQUESTS_INDEX_FIELD,
  type EVMType2TxParams,
  type SignBidirectionalEventLedgerIndex,
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

/** A zeroed calldata word: the value of every unused capacity slot. */
const ZERO_WORD = { kind: ABIWordKind.staticArg, value: new Uint8Array(32) };

/**
 * Known-good caller-supplied tx envelope for a deposit — the base every test
 * varies from. The calldata is `none` (the CONTRACT builds it; the Maybe's
 * default value still carries the <2, 0, 0> capacities the generated arg
 * check demands). Shared across tests: NEVER mutate; build a variation as an
 * explicit spread of this base with the delta inline (see
 * {@link DEPOSIT_REJECTION_CASES}).
 */
const VALID_TX_PARAMS: EVMType2TxParams = {
  to: ERC20,
  chainId: 11155111n,
  nonce: 0n,
  gasLimit: 100000n,
  maxFeePerGas: 30000000000n,
  maxPriorityFeePerGas: 2000000000n,
  value: 0n,
  accessListEntryCount: 0n,
  accessList: [],
  calldata: {
    is_some: false,
    value: { selector: new Uint8Array(4), words: [ZERO_WORD, ZERO_WORD] },
  },
};

/** The flat MPC routing arguments of requestDeposit, in circuit order. */
interface RoutingArgs {
  caip2Id: Uint8Array;
  keyVersion: bigint;
  path: Uint8Array;
  algo: Uint8Array;
  dest: Uint8Array;
  mpcParams: Uint8Array;
  outputDeserializationSchema: Uint8Array;
  respondSerializationSchema: Uint8Array;
}

/**
 * Known-good routing args — the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread.
 */
const VALID_ROUTING: RoutingArgs = {
  caip2Id: asciiPadded("eip155:11155111", 32),
  keyVersion: 1n,
  path: signetPathOfCommitment(DEPLOYER_COMMITMENT),
  algo: asciiPadded("ecdsa", 32),
  dest: asciiPadded("ethereum", 32),
  mpcParams: bytes(64, 0),
  outputDeserializationSchema: bytes(128, 0x07),
  respondSerializationSchema: bytes(128, 0x08),
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

/** Call requestDeposit with its flat routing args spread in circuit order. */
const requestDeposit = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["requestDeposit"]>[0],
  txParams: EVMType2TxParams,
  routing: RoutingArgs,
  args: DepositArgs,
) =>
  contract.circuits.requestDeposit(
    ctx,
    txParams,
    routing.caip2Id,
    routing.keyVersion,
    routing.path,
    routing.algo,
    routing.dest,
    routing.mpcParams,
    routing.outputDeserializationSchema,
    routing.respondSerializationSchema,
    args,
  );

// ---- Tests ----

describe("erc20-vault ledger shape", () => {
  it("signetRequestsIndex parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerIndex: SignBidirectionalEventLedgerIndex = ledger(
      ctx.callContext.currentQueryContext.state,
    ).signetRequestsIndex;

    expect(ledgerIndex.isEmpty()).toBe(true);
    expect(toSignBidirectionalEventIndex(ledgerIndex).size).toBe(0);
  });

  it("MPC-style: finds the request index in RAW state by position, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    const node = signetFieldNode(rawState, SIGNET_REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(rawState);
    const typedIndex = toSignBidirectionalEventIndex(
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

describe("evmAddressAbiValue", () => {
  it("TS mirror matches the compiled circuit's big-endian address value", () => {
    // The compiled circuit returns the BE numeric value as a Field bigint;
    // the TS mirror returns its 32-byte LE embed — same number.
    expect(bytesToBigintLE(evmAddressAbiWord(VAULT_EVM))).toBe(
      signetCircuits.evmAddressAbiValue(VAULT_EVM),
    );
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
      await requestDeposit(contract, ctx, VALID_TX_PARAMS, VALID_ROUTING, VALID_ARGS)
    ).context;
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(state).signetRequestsIndex,
    );
    // Read 2: MPC-style raw read — no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(state);

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    // The raw counter read matches the generated one.
    expect(rawLedger.nonce).toBe(ledger(state).signetNonce);

    const [idHex, record] = [...typedIndex.entries()][0];

    // Caller-supplied parts come back verbatim: the tx envelope (calldata
    // aside) and the flat routing fields.
    const { calldata, ...envelope } = record.txParams;
    const { calldata: _, ...expectedEnvelope } = VALID_TX_PARAMS;
    expect(envelope).toEqual(expectedEnvelope);
    expect(record.caip2Id).toEqual(VALID_ROUTING.caip2Id);
    expect(record.keyVersion).toBe(VALID_ROUTING.keyVersion);
    expect(record.path).toEqual(VALID_ROUTING.path);
    expect(record.algo).toEqual(VALID_ROUTING.algo);
    expect(record.dest).toEqual(VALID_ROUTING.dest);
    expect(record.params).toEqual(VALID_ROUTING.mpcParams);
    expect(record.outputDeserializationSchema).toEqual(
      VALID_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(
      VALID_ROUTING.respondSerializationSchema,
    );
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(vaultEvmAddress, amount) as tagged
    // words — the raw selector, the BE-embedded address, the LE amount.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual({
      kind: ABIWordKind.staticArg,
      value: evmAddressAbiWord(VAULT_EVM),
    });
    expect(calldata.value.words[1].kind).toBe(ABIWordKind.staticArg);
    expect(bytesToBigintLE(calldata.value.words[1].value)).toBe(AMOUNT);

    // The map key IS the domain-separated hash of the record — recomputed
    // off-chain with the library's TS twin of the request-id circuit. This
    // assertion is the lockstep check the twin's deviation note relies on:
    // the id computed in TS must equal the key the REAL compiled contract
    // minted in-circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

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
  /** Complete tx envelope passed to the circuit. */
  txParams: EVMType2TxParams;
  /** Complete routing args passed to the circuit. */
  routing: RoutingArgs;
  /** Complete deposit request args passed to the circuit. */
  args: DepositArgs;
  /** Error the circuit must throw. */
  throws: RegExp;
}

const DEPOSIT_REJECTION_CASES: DepositRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    txParams: { ...VALID_TX_PARAMS, to: ZERO_ADDRESS },
    routing: VALID_ROUTING,
    args: { ...VALID_ARGS, erc20Address: ZERO_ADDRESS },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero amount",
    txParams: VALID_TX_PARAMS,
    routing: VALID_ROUTING,
    args: { ...VALID_ARGS, amount: 0n },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unclaimable)",
    txParams: VALID_TX_PARAMS,
    routing: VALID_ROUTING,
    args: { ...VALID_ARGS, amount: UINT64_MAX + 1n },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "an EVM 'to' that is not the ERC20 contract",
    txParams: { ...VALID_TX_PARAMS, to: bytes(20, 0xbb) },
    routing: VALID_ROUTING,
    args: VALID_ARGS,
    throws: /EVM 'to' must be the ERC20 contract/,
  },
  {
    name: "a nonzero ETH value",
    txParams: { ...VALID_TX_PARAMS, value: 1n },
    routing: VALID_ROUTING,
    args: VALID_ARGS,
    throws: /No ETH value for ERC20 transfer/,
  },
  {
    name: "a zero chain id",
    txParams: { ...VALID_TX_PARAMS, chainId: 0n },
    routing: VALID_ROUTING,
    args: VALID_ARGS,
    throws: /Chain ID must be positive/,
  },
  {
    name: "a zero gas limit",
    txParams: { ...VALID_TX_PARAMS, gasLimit: 0n },
    routing: VALID_ROUTING,
    args: VALID_ARGS,
    throws: /Gas limit must be positive/,
  },
  {
    name: "a path bound to someone else's identity",
    txParams: VALID_TX_PARAMS,
    routing: { ...VALID_ROUTING, path: OTHER_PATH },
    args: VALID_ARGS,
    throws: /path hex does not match commitment/,
  },
  {
    name: "a path with garbage after the hex",
    txParams: VALID_TX_PARAMS,
    routing: { ...VALID_ROUTING, path: DIRTY_PATH },
    args: VALID_ARGS,
    throws: /zero-padded/,
  },
  {
    name: "the legacy key version 0",
    txParams: VALID_TX_PARAMS,
    routing: { ...VALID_ROUTING, keyVersion: 0n },
    args: VALID_ARGS,
    throws: /keyVersion must be >= 1/,
  },
];

describe("deposit validation", () => {
  it.each(DEPOSIT_REJECTION_CASES)(
    "rejects $name",
    async ({ txParams, routing, args, throws }) => {
      const { contract, ctx } = await deployInitialized();
      await expect(
        requestDeposit(contract, ctx, txParams, routing, args),
      ).rejects.toThrow(throws);
    },
  );

  it("rejects before initialize", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      requestDeposit(contract, ctx, VALID_TX_PARAMS, VALID_ROUTING, VALID_ARGS),
    ).rejects.toThrow(/Not initialized/);
  });

  it("identical deposits get DISTINCT ids — requestNonce differentiates them", async () => {
    // The dedup assert (!member) is a belt-and-braces invariant: it cannot
    // trip in the normal flow because the nonce is part of the hashed record,
    // so an identical resubmission is a NEW request. Document that here.
    const { contract, ctx } = await deployInitialized();

    const afterFirst = (
      await requestDeposit(contract, ctx, VALID_TX_PARAMS, VALID_ROUTING, VALID_ARGS)
    ).context;
    const afterSecond = (
      await requestDeposit(
        contract,
        afterFirst,
        VALID_TX_PARAMS,
        VALID_ROUTING,
        VALID_ARGS,
      )
    ).context;

    const index = toSignBidirectionalEventIndex(
      ledger(afterSecond.callContext.currentQueryContext.state)
        .signetRequestsIndex,
    );
    expect(index.size).toBe(2);
    const nonces = [...index.values()].map((r) => r.requestNonce).sort();
    expect(nonces).toEqual([0n, 1n]);
  });
});
