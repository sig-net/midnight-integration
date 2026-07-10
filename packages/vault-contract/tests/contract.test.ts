// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime — no ledger, no network, no proving.

import { describe, expect, it } from "vitest";

import {
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";

import {
  ERC20_TRANSFER_SELECTOR,
  calculateRequestId,
  deriveJubjubKeypair,
  evmAddressAbiWord,
  hexToBytes,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  requestIdBytes,
  requestIdHex,
  signetFieldNode,
  signetPathOfCommitment,
  toSignBidirectionalRequestIndex,
  SIGNET_REQUESTS_INDEX_FIELD,
  type SignBidirectionalRequestLedgerIndex,
} from "@midnight-erc20-vault/signet-midnight";

import {
  Contract,
  createVaultPrivateState,
  ledger,
  pureCircuits,
  witnesses,
  type VaultPrivateState,
} from "../src/index.ts";
// The signet contract (callee) module — the same one the vault's generated code
// cross-contract-calls. The request circuits end in a call to its
// emitSignBidirectionalEvent, so the simulator needs its state (see
// signetStateProvider) to execute that path.
import * as SignetEventEmitter from "../src/managed/SignetEventEmitter/contract/index.js";

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

// The signet contract (callee) the vault seals + cross-contract-calls. A valid
// sample contract address so the runtime's address checks pass.
const SIGNET_ADDRESS = sampleContractAddress();
const SIGNET_CONTRACT_REF = {
  bytes: Uint8Array.from(Buffer.from(SIGNET_ADDRESS, "hex")),
};
const BLOCK_HASH = "0".repeat(64);

/**
 * A ContractStateProvider serving the signet contract's initial state to the
 * simulator's cross-contract call — how the request circuits reach
 * emitSignBidirectionalEvent in-process (no node/indexer). Returns the state
 * for any address: the vault only calls the single sealed signet contract.
 */
const signetStateProvider = async () => {
  const signet = new SignetEventEmitter.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
    MPC_KEYS.pk,
  );
  return { getContractState: async () => currentContractState };
};

const VAULT_EVM = bytes(20, 0xee);
const ERC20 = bytes(20, 0xaa);
const ZERO_ADDRESS = new Uint8Array(20);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;

// The chain config initialize() pins (matching Sepolia's CAIP-2 form).
const CHAIN_ID = 11155111n;
const CAIP2_ID = asciiPadded("eip155:11155111", 32);

// The simulated vault's own contract address — fixed so tests can compute the
// token colors requestWithdraw checks against kernel.self().
const VAULT_ADDRESS = sampleContractAddress();

// The contract-fixed MPC routing of every vault request (mirrors the
// in-circuit vaultMpcRouting constants; the round-trip tests below are the
// lockstep check for these values, including the escaped JSON schema).
const EXPECTED_ROUTING = {
  algo: asciiPadded("ecdsa", 32),
  dest: asciiPadded("ethereum", 32),
  params: new Uint8Array(64),
  outputDeserializationSchema: asciiPadded('[{"name":"success","type":"bool"}]', 128),
  respondSerializationSchema: asciiPadded('[{"name":"success","type":"bool"}]', 128),
};

/**
 * The deposit circuit's flat arguments, in circuit order. The compact
 * compiler inlines the `DepositRequest` struct type anonymously into the
 * generated circuit signature; the `deposit` member matches it structurally.
 */
interface DepositCallArgs {
  evmNonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  keyVersion: bigint;
  path: Uint8Array;
  deposit: { erc20Address: Uint8Array; amount: bigint };
}

/**
 * Known-good deposit call args — the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread
 * of this base with the delta inline (see {@link DEPOSIT_REJECTION_CASES}).
 */
const VALID_DEPOSIT: DepositCallArgs = {
  evmNonce: 0n,
  gasLimit: 100000n,
  maxFeePerGas: 30000000000n,
  maxPriorityFeePerGas: 2000000000n,
  keyVersion: 1n,
  path: signetPathOfCommitment(DEPLOYER_COMMITMENT),
  deposit: { erc20Address: ERC20, amount: AMOUNT },
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
      SIGNET_CONTRACT_REF,
    );
  const ctx = createCircuitContext(
    "requestDeposit",
    VAULT_ADDRESS,
    CPK,
    currentContractState,
    currentPrivateState,
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    BLOCK_HASH,
  );
  return { contract, ctx };
};

/** Deploy + initialize(VAULT_EVM, CHAIN_ID, CAIP2_ID) as the deployer. */
const deployInitialized = async () => {
  const { contract, ctx } = await deployContract();
  const next = (await contract.circuits.initialize(ctx, VAULT_EVM, CHAIN_ID, CAIP2_ID)).context;
  return { contract, ctx: next };
};

/** Call requestDeposit with its flat args spread in circuit order. */
const requestDeposit = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["requestDeposit"]>[0],
  args: DepositCallArgs,
) =>
  contract.circuits.requestDeposit(
    ctx,
    args.evmNonce,
    args.gasLimit,
    args.maxFeePerGas,
    args.maxPriorityFeePerGas,
    args.keyVersion,
    args.path,
    args.deposit,
  );

// ---- Tests ----

describe("erc20-vault ledger shape", () => {
  it("signetRequestsIndex parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerIndex: SignBidirectionalRequestLedgerIndex = ledger(
      ctx.callContext.currentQueryContext.state,
    ).signetRequestsIndex;

    expect(ledgerIndex.isEmpty()).toBe(true);
    expect(toSignBidirectionalRequestIndex(ledgerIndex).size).toBe(0);
  });

  it("MPC-style: finds the request index in RAW state by position, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    const node = signetFieldNode(rawState, SIGNET_REQUESTS_INDEX_FIELD);
    expect(node.type()).toBe("map");

    const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(rawState);
    const typedIndex = toSignBidirectionalRequestIndex(
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
    await expect(
      contract.circuits.initialize(ctx, VAULT_EVM, CHAIN_ID, CAIP2_ID),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("is one-shot", async () => {
    const { contract, ctx } = await deployInitialized();
    await expect(
      contract.circuits.initialize(ctx, VAULT_EVM, CHAIN_ID, CAIP2_ID),
    ).rejects.toThrow(/Already initialized/);
  });

  it("rejects a zero chain id", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialize(ctx, VAULT_EVM, 0n, CAIP2_ID),
    ).rejects.toThrow(/Chain ID must be positive/);
  });

  it("stores the vault EVM address and the chain config", async () => {
    const { ctx } = await deployInitialized();
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.vaultEvmAddress).toEqual(VAULT_EVM);
    expect(state.evmChainId).toBe(CHAIN_ID);
    expect(state.caip2Id).toEqual(CAIP2_ID);
  });
});

describe("deposit round-trip", () => {
  it("stores a fully contract-composed request readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployInitialized();

    const next = (await requestDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalRequestIndex(
      ledger(state).signetRequestsIndex,
    );
    // Read 2: MPC-style raw read — no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(state);

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    // The raw counter read matches the generated one.
    expect(rawLedger.nonce).toBe(ledger(state).signetNonce);

    const [idHex, record] = [...typedIndex.entries()][0];

    // The contract-composed envelope: the deposit's token on the
    // initialize-pinned chain, no ETH value, the caller's nonce + gas args.
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: VALID_DEPOSIT.evmNonce,
      gasLimit: VALID_DEPOSIT.gasLimit,
      maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
      maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });

    // Caller-supplied routing comes back verbatim; the contract-fixed routing
    // matches the TS expectations — the LOCKSTEP CHECK for the in-circuit
    // vaultMpcRouting constants (including the escaped JSON schema literal).
    expect(record.caip2Id).toEqual(CAIP2_ID);
    expect(record.keyVersion).toBe(VALID_DEPOSIT.keyVersion);
    expect(record.path).toEqual(VALID_DEPOSIT.path);
    expect(record.algo).toEqual(EXPECTED_ROUTING.algo);
    expect(record.dest).toEqual(EXPECTED_ROUTING.dest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(
      EXPECTED_ROUTING.respondSerializationSchema,
    );
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(vaultEvmAddress, amount) as words —
    // the raw selector, the BE-embedded address, the LE amount.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(VAULT_EVM));
    expect(bytesToBigintLE(calldata.value.words[1])).toBe(AMOUNT);

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
  /** Complete call args passed to the circuit. */
  args: DepositCallArgs;
  /** Error the circuit must throw. */
  throws: RegExp;
}

const DEPOSIT_REJECTION_CASES: DepositRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ZERO_ADDRESS, amount: AMOUNT } },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero amount",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ERC20, amount: 0n } },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unclaimable)",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ERC20, amount: UINT64_MAX + 1n } },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "a zero gas limit",
    args: { ...VALID_DEPOSIT, gasLimit: 0n },
    throws: /Gas limit must be positive/,
  },
  {
    name: "a path bound to someone else's identity",
    args: { ...VALID_DEPOSIT, path: OTHER_PATH },
    throws: /path hex does not match commitment/,
  },
  {
    name: "a path with garbage after the hex",
    args: { ...VALID_DEPOSIT, path: DIRTY_PATH },
    throws: /zero-padded/,
  },
  {
    name: "the legacy key version 0",
    args: { ...VALID_DEPOSIT, keyVersion: 0n },
    throws: /keyVersion must be >= 1/,
  },
];

describe("deposit validation", () => {
  it.each(DEPOSIT_REJECTION_CASES)(
    "rejects $name",
    async ({ args, throws }) => {
      const { contract, ctx } = await deployInitialized();
      await expect(requestDeposit(contract, ctx, args)).rejects.toThrow(throws);
    },
  );

  it("rejects before initialize", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      requestDeposit(contract, ctx, VALID_DEPOSIT),
    ).rejects.toThrow(/Not initialized/);
  });

  it("identical deposits get DISTINCT ids — requestNonce differentiates them", async () => {
    // The dedup assert (!member) is a belt-and-braces invariant: it cannot
    // trip in the normal flow because the nonce is part of the hashed record,
    // so an identical resubmission is a NEW request. Document that here.
    const { contract, ctx } = await deployInitialized();

    const afterFirst = (await requestDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const afterSecond = (await requestDeposit(contract, afterFirst, VALID_DEPOSIT)).context;

    const index = toSignBidirectionalRequestIndex(
      ledger(afterSecond.callContext.currentQueryContext.state)
        .signetRequestsIndex,
    );
    expect(index.size).toBe(2);
    const nonces = [...index.values()].map((r) => r.requestNonce).sort();
    expect(nonces).toEqual([0n, 1n]);
  });
});

// ---- Withdraw fixtures ----

// Where the vault sends the ERC20 on withdraw.
const DEST_EVM = bytes(20, 0xdd);

// The refund recipient pinned at request time (any Zswap coin public key).
const REFUND_PK = { bytes: bytes(32, 0x05) };

// The vault token color for ERC20 at the simulated contract address —
// computed exactly as a wallet would: the compiled domain-separator circuit
// plus the runtime's rawTokenType (the off-chain twin of the in-circuit
// `tokenType(domainSep, kernel.self())`).
const VAULT_TOKEN_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(ERC20), VAULT_ADDRESS),
);

/** A surrendered vault coin: fixed nonce, vault-token color, given value. */
const vaultCoin = (value: bigint, color: Uint8Array = VAULT_TOKEN_COLOR) => ({
  nonce: bytes(32, 0x0c),
  color,
  value,
});

/**
 * The withdraw circuit's flat arguments, in circuit order. The compact
 * compiler inlines the `WithdrawRequest` struct type anonymously into the
 * generated circuit signature; the `withdraw` member matches it structurally.
 */
interface WithdrawCallArgs {
  evmNonce: bigint;
  keyVersion: bigint;
  withdraw: { erc20Address: Uint8Array; amount: bigint; destEvmAddress: Uint8Array };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good withdraw call args — the base every test varies from.
 * Shared across tests: NEVER mutate; build a variation as an explicit spread.
 */
const VALID_WITHDRAW: WithdrawCallArgs = {
  evmNonce: 0n,
  keyVersion: 1n,
  withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_EVM },
  coin: vaultCoin(AMOUNT),
};

/**
 * Call requestWithdraw with its flat args spread in circuit order. The
 * refund recipient is always {@link REFUND_PK} — the circuit records it
 * verbatim without validation, so it is arrange, not input.
 */
const requestWithdraw = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["requestWithdraw"]>[0],
  args: WithdrawCallArgs,
) =>
  contract.circuits.requestWithdraw(
    ctx,
    args.evmNonce,
    args.keyVersion,
    args.withdraw,
    args.coin,
    REFUND_PK,
  );

// ---- Withdraw tests ----

describe("withdraw round-trip", () => {
  it("burns the coin and stores a vault-path request with a contract-fixed envelope", async () => {
    const { contract, ctx } = await deployInitialized();

    const next = (await requestWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const state = next.callContext.currentQueryContext.state;

    const index = toSignBidirectionalRequestIndex(
      ledger(state).signetRequestsIndex,
    );
    expect(index.size).toBe(1);
    const [idHex, record] = [...index.entries()][0];

    // The derivation path is the contract-fixed literal "vault" — the MPC
    // signs with the VAULT's derived EVM account, not the caller's.
    expect(record.path).toEqual(asciiPadded("vault", 256));

    // The envelope is contract-composed end to end: the withdraw's token on
    // the initialize-pinned chain, the caller's account nonce, and the
    // CONTRACT-FIXED gas envelope. The gas literals here are the lockstep
    // check for the cli's ERC20_TRANSFER_* constants (packages/cli/src/evm.ts),
    // which rebuild this record off-chain.
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: VALID_WITHDRAW.evmNonce,
      gasLimit: 100_000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });

    // Contract-fixed routing, same constants as deposits.
    expect(record.caip2Id).toEqual(CAIP2_ID);
    expect(record.keyVersion).toBe(VALID_WITHDRAW.keyVersion);
    expect(record.algo).toEqual(EXPECTED_ROUTING.algo);
    expect(record.dest).toEqual(EXPECTED_ROUTING.dest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(
      EXPECTED_ROUTING.respondSerializationSchema,
    );
    expect(record.requestNonce).toBe(0n);

    // Contract-built calldata: transfer(destEvmAddress, amount) as words —
    // the raw selector, the BE-embedded address, the LE amount.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(DEST_EVM));
    expect(bytesToBigintLE(calldata.value.words[1])).toBe(AMOUNT);

    // TS-twin lockstep: the ledger map key is the id the library recomputes.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // The refund recipient is pinned under the request id; nonce bumped. The
    // surrendered coin leaves no other trace — it is burned, by design.
    expect(ledger(state).refundRecipient.member(requestIdBytes(idHex))).toBe(true);
    expect(ledger(state).refundRecipient.lookup(requestIdBytes(idHex))).toEqual(
      REFUND_PK.bytes,
    );
    expect(ledger(state).signetNonce).toBe(1n);
  });

  it("concurrent withdrawals across DIFFERENT ERC20 colors both land", async () => {
    // No shared escrow slot: each withdrawal only touches its own request-id
    // keyed entries, so coins of different colors surrendered back-to-back
    // must both record.
    const { contract, ctx } = await deployInitialized();
    const otherErc20 = bytes(20, 0xab);
    const otherColor = hexToBytes(
      rawTokenType(pureCircuits.vaultTokenDomainSeparator(otherErc20), VAULT_ADDRESS),
    );

    const afterFirst = (await requestWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const afterSecond = (
      await requestWithdraw(contract, afterFirst, {
        ...VALID_WITHDRAW,
        withdraw: { erc20Address: otherErc20, amount: AMOUNT, destEvmAddress: DEST_EVM },
        coin: vaultCoin(AMOUNT, otherColor),
      })
    ).context;

    const state = afterSecond.callContext.currentQueryContext.state;
    const index = toSignBidirectionalRequestIndex(ledger(state).signetRequestsIndex);
    expect(index.size).toBe(2);
    expect(ledger(state).refundRecipient.size()).toBe(2n);
  });
});

/** One row of the withdraw rejection table: full inputs → expected error. */
interface WithdrawRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to the circuit. */
  args: WithdrawCallArgs;
  /** Error the circuit must throw. */
  throws: RegExp;
}

const WITHDRAW_REJECTION_CASES: WithdrawRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ZERO_ADDRESS, amount: AMOUNT, destEvmAddress: DEST_EVM },
    },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero amount",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: 0n, destEvmAddress: DEST_EVM },
      coin: vaultCoin(0n),
    },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unrefundable)",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: UINT64_MAX + 1n, destEvmAddress: DEST_EVM },
      coin: vaultCoin(UINT64_MAX + 1n),
    },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "the legacy key version 0",
    args: { ...VALID_WITHDRAW, keyVersion: 0n },
    throws: /keyVersion must be >= 1/,
  },
  {
    name: "a coin that is not the vault token for this ERC20",
    args: { ...VALID_WITHDRAW, coin: vaultCoin(AMOUNT, bytes(32, 0x99)) },
    throws: /Coin is not the vault token for this ERC20/,
  },
  {
    name: "a coin whose value differs from the withdraw amount",
    args: { ...VALID_WITHDRAW, coin: vaultCoin(AMOUNT - 1n) },
    throws: /Coin value must equal the withdraw amount/,
  },
];

describe("withdraw validation", () => {
  it.each(WITHDRAW_REJECTION_CASES)(
    "rejects $name",
    async ({ args, throws }) => {
      const { contract, ctx } = await deployInitialized();
      await expect(requestWithdraw(contract, ctx, args)).rejects.toThrow(throws);
    },
  );

  it("rejects before initialize", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      requestWithdraw(contract, ctx, VALID_WITHDRAW),
    ).rejects.toThrow(/Not initialized/);
  });
});
