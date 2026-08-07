// The remote-wallet wire contract, stated ONCE: the protocol version, the
// method set, and one request/response codec per method. Both stubs
// (RemoteWalletClient, RemoteWalletServer) read this module, so the two
// sides of the wire cannot drift apart. Every message is UTF-8 JSON:
// transactions travel as hex of the ledger's own binary serialisation,
// bigints as decimal strings, dates as ISO-8601 strings.

import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js/types";
import type {
  Binding,
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  PreBinding,
  PreProof,
  Proof,
  RawTokenType,
  Signature,
  SignatureEnabled,
  SignatureKind,
  TransactionId,
  UnprovenTransaction,
} from "@midnightntwrk/ledger-v9";
import { Transaction } from "@midnightntwrk/ledger-v9";
import { bytesToHex, hexToBytes } from "@sig-net/midnight";

import { NETWORK_IDS, type NetworkId } from "../network-id.ts";
import type { WalletAddresses } from "../Wallet.ts";

/**
 * Version of the wire contract in this file. The server states it in the
 * {@link RemoteWalletHandshake} and the client refuses to proceed on a
 * mismatch. Bump it on ANY change to the method set or a codec's wire
 * shape.
 */
export const REMOTE_WALLET_PROTOCOL_VERSION = 1;

/**
 * The remote-wallet method set: {@link RemoteWalletMethod.Handshake} plus
 * one member per remote-callable `Wallet` method. The member value is the
 * method's name on the wire.
 */
export enum RemoteWalletMethod {
  Handshake = "handshake",
  Synced = "synced",
  GetShieldedBalances = "getShieldedBalances",
  GetUnshieldedBalances = "getUnshieldedBalances",
  GetDustBalance = "getDustBalance",
  SignData = "signData",
  BalanceTx = "balanceTx",
  BalanceUnprovenTx = "balanceUnprovenTx",
  SubmitTx = "submitTx",
}

/**
 * One payload's wire representation: a domain value in, bytes out, and
 * back. `decode` treats its input as untrusted and throws on anything
 * malformed.
 */
export interface Codec<Value> {
  /**
   * Encode a domain value into its wire bytes.
   *
   * @param value - The domain value to encode.
   * @returns The wire bytes.
   */
  encode(value: Value): Uint8Array;
  /**
   * Decode wire bytes back into the domain value.
   *
   * @param bytes - The untrusted wire bytes.
   * @returns The decoded domain value.
   * @throws {Error} If the bytes do not hold a well-formed value.
   */
  decode(bytes: Uint8Array): Value;
}

/**
 * A method's codec pair: one for its request payload, one for its
 * response payload.
 */
export interface MethodCodecs<Request, Response> {
  /** Codec for the method's request payload. */
  request: Codec<Request>;
  /** Codec for the method's response payload. */
  response: Codec<Response>;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// The shapes this protocol writes as JSON. `undefined` object members are
// dropped by JSON.stringify, which is how optional fields stay absent on
// the wire.
type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

function encodeJson(value: JsonValue): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array, context: string): unknown {
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as unknown;
  } catch {
    throw new Error(`${context}: not valid JSON`);
  }
}

function parseRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context}: expected a string`);
  }
  return value;
}

function parseBigInt(value: unknown, context: string): bigint {
  const text = parseString(value, context);
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${context}: expected a decimal integer string`);
  }
  return BigInt(text);
}

function parseHexBytes(value: unknown, context: string): Uint8Array {
  const text = parseString(value, context);
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) {
    throw new Error(`${context}: expected an even-length hex string`);
  }
  return hexToBytes(text);
}

// Methods whose request carries no data send an empty payload; whatever a
// transport delivers for "empty" is ignored on decode.
const voidCodec: Codec<void> = {
  encode: () => new Uint8Array(0),
  decode: () => undefined,
};

/**
 * What the server tells a connecting client: the wire-contract version it
 * speaks and the identity of the wallet it hosts, which is everything a
 * {@link import("./RemoteWallet.ts").RemoteWallet} needs to answer the
 * `Wallet` interface's synchronous reads without further round trips.
 */
export interface RemoteWalletHandshake {
  /** The server's {@link REMOTE_WALLET_PROTOCOL_VERSION}. */
  protocolVersion: number;
  /** The network the hosted wallet lives on. */
  networkId: NetworkId;
  /** The hosted wallet's three addresses. */
  addresses: WalletAddresses;
  /** The hosted wallet's coin public key, hex-encoded. */
  coinPublicKey: CoinPublicKey;
  /** The hosted wallet's encryption public key, hex-encoded. */
  encryptionPublicKey: EncPublicKey;
}

const handshakeCodec: Codec<RemoteWalletHandshake> = {
  encode: (handshake) =>
    encodeJson({
      protocolVersion: handshake.protocolVersion,
      networkId: handshake.networkId,
      addresses: { ...handshake.addresses },
      coinPublicKey: handshake.coinPublicKey,
      encryptionPublicKey: handshake.encryptionPublicKey,
    }),
  decode: (bytes) => {
    const context = "handshake response";
    const record = parseRecord(decodeJson(bytes, context), context);
    const version = record.protocolVersion;
    if (typeof version !== "number") {
      throw new Error(`${context}: expected a numeric protocolVersion`);
    }
    const networkId = parseString(record.networkId, `${context} (networkId)`);
    if (!NETWORK_IDS.includes(networkId)) {
      throw new Error(
        `${context} (networkId): unknown network "${networkId}", expected one of: ${NETWORK_IDS.join(", ")}`,
      );
    }
    const addresses = parseRecord(record.addresses, `${context} (addresses)`);
    return {
      protocolVersion: version,
      networkId,
      addresses: {
        unshielded: parseString(addresses.unshielded, `${context} (addresses.unshielded)`),
        shielded: parseString(addresses.shielded, `${context} (addresses.shielded)`),
        dust: parseString(addresses.dust, `${context} (addresses.dust)`),
      },
      coinPublicKey: parseString(record.coinPublicKey, `${context} (coinPublicKey)`),
      encryptionPublicKey: parseString(
        record.encryptionPublicKey,
        `${context} (encryptionPublicKey)`,
      ),
    };
  },
};

const syncedCodec: Codec<boolean> = {
  encode: (value) => encodeJson(value),
  decode: (bytes) => {
    const value = decodeJson(bytes, "synced response");
    if (typeof value !== "boolean") {
      throw new Error("synced response: expected a boolean");
    }
    return value;
  },
};

function balancesCodec(context: string): Codec<Record<RawTokenType, bigint>> {
  return {
    encode: (balances) =>
      encodeJson(
        Object.fromEntries(
          Object.entries(balances).map(([token, amount]) => [token, amount.toString()]),
        ),
      ),
    decode: (bytes) => {
      const record = parseRecord(decodeJson(bytes, context), context);
      return Object.fromEntries(
        Object.entries(record).map(([token, amount]) => [
          token,
          parseBigInt(amount, `${context} (token ${token})`),
        ]),
      );
    },
  };
}

const dustBalanceCodec: Codec<bigint> = {
  encode: (value) => encodeJson(value.toString()),
  decode: (bytes) =>
    parseBigInt(decodeJson(bytes, "getDustBalance response"), "getDustBalance response"),
};

const signDataRequestCodec: Codec<Uint8Array> = {
  encode: (data) => encodeJson(bytesToHex(data)),
  decode: (bytes) => parseHexBytes(decodeJson(bytes, "signData request"), "signData request"),
};

// SignatureKind is type-level only in the ledger package, so its runtime
// mirror for validating wire data lives here.
const SIGNATURE_KINDS: readonly SignatureKind[] = ["schnorr", "ecdsa"];

function isSignatureKind(value: string): value is SignatureKind {
  return (SIGNATURE_KINDS as readonly string[]).includes(value);
}

const signatureCodec: Codec<Signature> = {
  encode: (signature) => encodeJson({ tag: signature.tag, value: signature.value }),
  decode: (bytes) => {
    const context = "signData response";
    const record = parseRecord(decodeJson(bytes, context), context);
    const tag = parseString(record.tag, `${context} (tag)`);
    if (!isSignatureKind(tag)) {
      throw new Error(`${context} (tag): expected one of ${SIGNATURE_KINDS.join(", ")}`);
    }
    return { tag, value: parseString(record.value, `${context} (value)`) };
  },
};

// The three transaction stages share one wire shape (hex of the ledger's
// binary serialisation) and differ only in the markers their deserialiser
// restores.
function transactionCodec<
  TransactionType extends UnprovenTransaction | UnboundTransaction | FinalizedTransaction,
>(deserialize: (raw: Uint8Array) => TransactionType, context: string): Codec<TransactionType> {
  return {
    encode: (transaction) => encodeJson(bytesToHex(transaction.serialize())),
    decode: (bytes) => deserialize(parseHexBytes(decodeJson(bytes, context), context)),
  };
}

const deserializeUnprovenTransaction = (raw: Uint8Array): UnprovenTransaction =>
  Transaction.deserialize<SignatureEnabled, PreProof, PreBinding>(
    "signature",
    "pre-proof",
    "pre-binding",
    raw,
  );
const deserializeUnboundTransaction = (raw: Uint8Array): UnboundTransaction =>
  Transaction.deserialize<SignatureEnabled, Proof, PreBinding>(
    "signature",
    "proof",
    "pre-binding",
    raw,
  );
const deserializeFinalizedTransaction = (raw: Uint8Array): FinalizedTransaction =>
  Transaction.deserialize<SignatureEnabled, Proof, Binding>("signature", "proof", "binding", raw);

const finalizedTransactionCodec = transactionCodec(
  deserializeFinalizedTransaction,
  "finalized transaction payload",
);

/**
 * Request payload of the two balancing methods: the transaction to
 * balance, plus the optional validity deadline the `Wallet` balancing
 * methods take. An absent `ttl` means the hosted wallet applies its own
 * default.
 */
export interface BalanceTransactionRequest<TransactionType> {
  /** The transaction to balance. */
  transaction: TransactionType;
  /** Validity deadline of the balancing plan. */
  ttl?: Date;
}

function balanceRequestCodec<TransactionType extends UnprovenTransaction | UnboundTransaction>(
  deserialize: (raw: Uint8Array) => TransactionType,
  context: string,
): Codec<BalanceTransactionRequest<TransactionType>> {
  return {
    encode: ({ transaction, ttl }) =>
      encodeJson({ transaction: bytesToHex(transaction.serialize()), ttl: ttl?.toISOString() }),
    decode: (bytes) => {
      const record = parseRecord(decodeJson(bytes, context), context);
      const transaction = deserialize(
        parseHexBytes(record.transaction, `${context} (transaction)`),
      );
      const ttlValue = record.ttl;
      if (ttlValue === undefined) {
        return { transaction };
      }
      const ttl = new Date(parseString(ttlValue, `${context} (ttl)`));
      if (Number.isNaN(ttl.getTime())) {
        throw new Error(`${context} (ttl): expected an ISO-8601 date string`);
      }
      return { transaction, ttl };
    },
  };
}

const transactionIdCodec: Codec<TransactionId> = {
  encode: (id) => encodeJson(id),
  decode: (bytes) => parseString(decodeJson(bytes, "submitTx response"), "submitTx response"),
};

/**
 * The codec pair of every {@link RemoteWalletMethod}, precisely typed per
 * method. Both stubs index {@link remoteWalletCodecs}, so each method's
 * wire shape has exactly one definition.
 */
export interface RemoteWalletCodecs {
  /** Handshake: empty request, version + hosted-wallet identity back. */
  [RemoteWalletMethod.Handshake]: MethodCodecs<void, RemoteWalletHandshake>;
  /** Sync probe: empty request, whether the hosted view is synced back. */
  [RemoteWalletMethod.Synced]: MethodCodecs<void, boolean>;
  /** Shielded balances: empty request, token-to-amount map back. */
  [RemoteWalletMethod.GetShieldedBalances]: MethodCodecs<void, Record<RawTokenType, bigint>>;
  /** Unshielded balances: empty request, token-to-amount map back. */
  [RemoteWalletMethod.GetUnshieldedBalances]: MethodCodecs<void, Record<RawTokenType, bigint>>;
  /** Dust balance: empty request, spendable DUST in base units back. */
  [RemoteWalletMethod.GetDustBalance]: MethodCodecs<void, bigint>;
  /** Data signing: bytes to sign in, the host's signature back. */
  [RemoteWalletMethod.SignData]: MethodCodecs<Uint8Array, Signature>;
  /** Balance an unbound (proven) transaction into a finalized one. */
  [RemoteWalletMethod.BalanceTx]: MethodCodecs<
    BalanceTransactionRequest<UnboundTransaction>,
    FinalizedTransaction
  >;
  /** Balance an unproven transaction into a finalized one. */
  [RemoteWalletMethod.BalanceUnprovenTx]: MethodCodecs<
    BalanceTransactionRequest<UnprovenTransaction>,
    FinalizedTransaction
  >;
  /** Submit a finalized transaction, its id back. */
  [RemoteWalletMethod.SubmitTx]: MethodCodecs<FinalizedTransaction, TransactionId>;
}

/** The one {@link RemoteWalletCodecs} instance both stubs share. */
export const remoteWalletCodecs: RemoteWalletCodecs = {
  [RemoteWalletMethod.Handshake]: { request: voidCodec, response: handshakeCodec },
  [RemoteWalletMethod.Synced]: { request: voidCodec, response: syncedCodec },
  [RemoteWalletMethod.GetShieldedBalances]: {
    request: voidCodec,
    response: balancesCodec("getShieldedBalances response"),
  },
  [RemoteWalletMethod.GetUnshieldedBalances]: {
    request: voidCodec,
    response: balancesCodec("getUnshieldedBalances response"),
  },
  [RemoteWalletMethod.GetDustBalance]: { request: voidCodec, response: dustBalanceCodec },
  [RemoteWalletMethod.SignData]: { request: signDataRequestCodec, response: signatureCodec },
  [RemoteWalletMethod.BalanceTx]: {
    request: balanceRequestCodec(deserializeUnboundTransaction, "balanceTx request"),
    response: finalizedTransactionCodec,
  },
  [RemoteWalletMethod.BalanceUnprovenTx]: {
    request: balanceRequestCodec(deserializeUnprovenTransaction, "balanceUnprovenTx request"),
    response: finalizedTransactionCodec,
  },
  [RemoteWalletMethod.SubmitTx]: {
    request: finalizedTransactionCodec,
    response: transactionIdCodec,
  },
};
