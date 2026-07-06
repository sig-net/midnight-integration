// TypeScript twins of the request-side structs in the Compact library
// `Signet.compact` (same directory). The shapes MUST stay in lockstep with the Compact structs: the
// compiler inlines struct types anonymously into each contract's generated
// managed/contract/index.d.ts, and these named types match them structurally,
// so ledger reads assign to them without casts.
//
// The lockstep is enforced by each consuming contract's simulator tests: the
// "erc20-vault ledger shape" test in packages/vault-contract/tests/
// contract.test.ts assigns the generated `ledger().signetRequestsIndex` to the
// named SignetEVMSignatureRequestLedgerIndex type — the assignment itself is
// the assertion, so any structural drift between the generated managed types
// and these twins fails that package's `npm run build` / `npm run test`.
//
// Read more: https://docs.sig.network/ (signet protocol) and the module
// header in Signet.compact (layout convention, path binding).

/**
 * 32-byte signet request id (Compact: `new type SignetRequestId = Bytes<32>`).
 * Chain-agnostic: downstream consumers treat it as an opaque key. Each request
 * kind mints ids via its own domain-separated hash — for EVM requests,
 * `signetEVMSignatureRequestId` in Signet.compact hashes the full
 * {@link SignetEVMSignatureRequest} record under the "signet:evm:request:" tag.
 */
export type SignetRequestId = Uint8Array;

/**
 * The EVM transaction to be signed, decomposed into typed fields
 * (EIP-1559 / type-2 — https://eips.ethereum.org/EIPS/eip-1559).
 * Compact `Bytes<N>` fields arrive as N-byte `Uint8Array`s, `Uint<N>` as
 * `bigint`.
 */
export interface EVMTransactionParams {
  /** Call target (e.g. the ERC20 contract), 20 bytes. */
  to: Uint8Array;
  /** EVM chain id (also expressed in {@link SignetMPCRoutingParams.caip2Id}). */
  chainId: bigint;
  /** Account nonce of the MPC-derived sender address. */
  nonce: bigint;
  /** Gas ceiling for the call. */
  gasLimit: bigint;
  /** Max total fee per gas, wei. */
  maxFeePerGas: bigint;
  /** Max priority fee per gas, wei. */
  maxPriorityFeePerGas: bigint;
  /** ETH sent with the call, wei. */
  value: bigint;
}

/**
 * ABI calldata as function signature + fixed-capacity arg slots
 * (https://docs.soliditylang.org/en/latest/abi-spec.html).
 */
export interface EVMCalldata {
  /** Zero-padded ASCII signature, e.g. "transfer(address,uint256)"; 256 bytes. */
  funcSig: Uint8Array;
  /** How many leading slots of {@link args} are used. */
  argCount: bigint;
  /** Four 32-byte ABI words; unused slots are zero. */
  args: Uint8Array[];
}

/**
 * MPC routing: which key signs, for which chain, and how the response comes
 * back. See https://docs.sig.network/ for the key-derivation scheme.
 */
export interface SignetMPCRoutingParams {
  /** Target chain in CAIP-2 form (https://chainagnostic.org/CAIPs/caip-2), zero-padded; 64 bytes. */
  caip2Id: Uint8Array;
  /** MPC root-key version to derive from. */
  keyVersion: bigint;
  /** Key-derivation path: canonical lowercase hex of the caller's identity commitment, zero-padded; 256 bytes. */
  path: Uint8Array;
  /** Signature scheme, zero-padded ASCII, e.g. "ecdsa"; 32 bytes. */
  algo: Uint8Array;
  /** Response destination, zero-padded ASCII, e.g. "ethereum"; 64 bytes. */
  dest: Uint8Array;
  /** Scheme-specific extras, opaque; 512 bytes. */
  params: Uint8Array;
  /** MPC output_deserialization_schema; 256 bytes. */
  outputSchema: Uint8Array;
  /** MPC respond_serialization_schema; 256 bytes. */
  respondSchema: Uint8Array;
}

/**
 * Caller-supplied portion of a request (Compact:
 * `SignetEVMSignatureRequestParams`) — everything the dapp chooses freely.
 * Deliberately excludes calldata, which the requesting contract enforces.
 */
export interface SignetEVMSignatureRequestParams {
  evmTransaction: EVMTransactionParams;
  mpcRouting: SignetMPCRoutingParams;
}

/**
 * Canonical signet EVM signature request (Compact:
 * `SignetEVMSignatureRequest`), stored per {@link SignetRequestId} in a
 * contract's request index. Mirrors the MPC's SignBidirectionalEvent with the
 * EVM transaction decomposed; response-side output data is deliberately
 * absent (it lives in the signature-responses contract).
 */
export interface SignetEVMSignatureRequest {
  /** Contract-local nonce captured when the request was created. */
  requestNonce: bigint;
  evmTransaction: EVMTransactionParams;
  /** Contract-enforced calldata — never caller-chosen wholesale. */
  calldata: EVMCalldata;
  mpcRouting: SignetMPCRoutingParams;
}

/**
 * The generated ledger shape of `Map<SignetRequestId, SignetEVMSignatureRequest>`:
 * what a contract's `ledger(state).signetRequestsIndex` provides. Structural,
 * so any contract exposing the index satisfies it.
 */
export interface SignetEVMSignatureRequestLedgerIndex
  extends Iterable<[SignetRequestId, SignetEVMSignatureRequest]> {
  /** @returns `true` when the index holds no requests. */
  isEmpty(): boolean;
  /** @returns Number of requests in the index. */
  size(): bigint;
  /**
   * @param requestId - 32-byte request id to probe.
   * @returns `true` when the index holds an entry for `requestId`.
   */
  member(requestId: SignetRequestId): boolean;
  /**
   * @param requestId - 32-byte request id to fetch.
   * @returns The stored request record; throws when absent — guard with
   *   {@link member} first.
   */
  lookup(requestId: SignetRequestId): SignetEVMSignatureRequest;
}

/** Plain-JS index parsed out of the ledger, keyed by hex request id. */
export type SignetEVMSignatureRequestIndex = Map<
  string,
  SignetEVMSignatureRequest
>;

/**
 * Render a request id as a lowercase hex string, usable as a JS `Map` key
 * (`Uint8Array` keys compare by reference, so raw ids don't work as keys).
 *
 * @param requestId - 32-byte request id.
 * @returns 64-char lowercase hex string, no `0x` prefix.
 */
export function requestIdHex(requestId: SignetRequestId): string {
  return Array.from(requestId, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Byte width of the mpcRouting.path field (Compact `Bytes<256>`). */
export const PATH_BYTES = 256;

/**
 * Build the canonical MPC derivation path for an identity commitment: the
 * lowercase hex of the commitment as ASCII, zero-padded to {@link PATH_BYTES}
 * — exactly what the contract's `assertPathCommitment` accepts. Use this to
 * populate `SignetMPCRoutingParams.path` when constructing requests.
 *
 * @param commitment - 32-byte identity commitment.
 * @returns The 256-byte path field value.
 */
export function signetPathOfCommitment(commitment: Uint8Array): Uint8Array {
  const path = new Uint8Array(PATH_BYTES);
  path.set(new TextEncoder().encode(requestIdHex(commitment)));
  return path;
}

/**
 * Parse the on-ledger request map into a plain-JS index keyed by hex
 * request id.
 *
 * @param ledgerIndex - Iterable of `[requestId, request]` entries — e.g. a
 *   contract's `ledger(state).signetRequestsIndex` (any
 *   {@link SignetEVMSignatureRequestLedgerIndex}).
 * @returns A new `Map` from {@link requestIdHex} key to request record.
 */
export function toSignetEVMSignatureRequestIndex(
  ledgerIndex: Iterable<[SignetRequestId, SignetEVMSignatureRequest]>,
): SignetEVMSignatureRequestIndex {
  const index: SignetEVMSignatureRequestIndex = new Map();
  for (const [requestId, request] of ledgerIndex) {
    index.set(requestIdHex(requestId), request);
  }
  return index;
}
