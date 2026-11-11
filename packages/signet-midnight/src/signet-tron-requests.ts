// The Tron (TriggerSmartContract) instantiation of the signet request
// protocol: the TypeScript twin of the `TronTxParams` decomposition struct in
// `Signet.compact`, its runtime descriptors and its digest. Everything
// chain-agnostic lives in `signet-requests.ts`, and the transaction assembly
// in `tron-transactions.ts`.

import {
  type CompactType,
  transientHash,
  upgradeFromTransient,
} from "@midnight-ntwrk/compact-runtime";

import {
  BOOLEAN,
  BYTES_2,
  BYTES_4,
  BYTES_8,
  BYTES_21,
  compactMaybeDescriptor,
  compactStructDescriptor,
  compactTupleDescriptor,
  DOMAIN_FIELD_BYTES_32,
  HASH_DOMAIN,
  type Maybe,
  UINT_16,
  UINT_64,
} from "./compact-descriptors.ts";
import { HashDomain } from "./managed/contract/index.js";
import { type EvmCalldata, evmCalldataDescriptor } from "./signet-evtype2tx-requests.ts";
import {
  type SignBidirectionalEvent,
  signBidirectionalEventDescriptorWith,
} from "./signet-requests.ts";

/**
 * The CAIP-2 id the MPC routes every Tron request on, whichever Tron network
 * its deployment watches. A request's `executionDest` is this text
 * zero-padded to 64 bytes, as the compiled `pureCircuits.tronCaip2Id()`
 * returns it.
 */
export const TRON_CAIP2_ID = "tron:mainnet";

/**
 * The Tron transaction to be signed, a `TriggerSmartContract` call decomposed
 * into the fields of its protobuf raw message (Compact:
 * `TronTxParams<#maxCalldataWords>`). The owner address is not a field: the
 * MPC sets it from the request's derived key (see `buildTronRawTransaction`).
 */
export interface TronTxParams {
  /** The reference block height's low two bytes, big-endian. */
  refBlockBytes: Uint8Array;
  /** The reference block id's bytes 8..16. */
  refBlockHash: Uint8Array;
  /** Transaction timestamp, milliseconds. */
  timestamp: bigint;
  /** Transaction expiration, milliseconds. */
  expiration: bigint;
  /** Energy fee ceiling, sun. */
  feeLimit: bigint;
  /** The target contract: `0x41` followed by its 20-byte address. */
  contractAddress: Uint8Array;
  /** TRX sent with the call, sun. */
  callValue: bigint;
  /** Call data: `is_some: false` means empty call data. */
  calldata: Maybe<EvmCalldata>;
}

/**
 * Descriptor of {@link TronTxParams} at one calldata capacity: the TS
 * analogue of Compact's `TronTxParams<#maxCalldataWords>`.
 *
 * @param maxCalldataWords - Calldata word capacity.
 * @returns The tx-params descriptor.
 */
export function tronTxParamsDescriptor(maxCalldataWords: number): CompactType<TronTxParams> {
  // Key order IS the encoding order: keep it identical to the Compact struct's.
  return compactStructDescriptor<TronTxParams>({
    refBlockBytes: BYTES_2,
    refBlockHash: BYTES_8,
    timestamp: UINT_64,
    expiration: UINT_64,
    feeLimit: UINT_64,
    contractAddress: BYTES_21,
    callValue: UINT_64,
    calldata: compactMaybeDescriptor(evmCalldataDescriptor(maxCalldataWords)),
  });
}

/**
 * Descriptor of a Tron {@link SignBidirectionalEvent} at one capacity
 * instantiation: encodes a record to its stored ledger form and back.
 *
 * @param maxCalldataWords - Calldata word capacity.
 * @param lenOutputDeserialization - Declared byte width of
 *   `outputDeserializationSchema` (Compact `#LenOutputDeserialization`).
 * @param lenRespondSerialization - Declared byte width of
 *   `respondSerializationSchema` (Compact `#LenRespondSerialization`).
 * @returns The event record descriptor.
 */
export function tronSignBidirectionalEventDescriptor(
  maxCalldataWords: number,
  lenOutputDeserialization: number,
  lenRespondSerialization: number,
): CompactType<SignBidirectionalEvent<TronTxParams>> {
  return signBidirectionalEventDescriptorWith(
    tronTxParamsDescriptor(maxCalldataWords),
    lenOutputDeserialization,
    lenRespondSerialization,
  );
}

/** The digest's head tuple: the scalar fields, the calldata presence, selector and count. */
const TRON_DIGEST_HEAD = compactTupleDescriptor<
  [
    HashDomain,
    Uint8Array,
    Uint8Array,
    bigint,
    bigint,
    bigint,
    Uint8Array,
    bigint,
    boolean,
    Uint8Array,
    bigint,
  ]
>([
  HASH_DOMAIN,
  BYTES_2,
  BYTES_8,
  UINT_64,
  UINT_64,
  UINT_64,
  BYTES_21,
  UINT_64,
  BOOLEAN,
  BYTES_4,
  UINT_16,
]);

/**
 * Digest of a {@link TronTxParams} over the bytes that reach the signed
 * transaction, the TS twin of the `calculateTronTxParamsDigestV1` circuit
 * (lockstep-tested against its fixed-width oracles): the scalar fields with
 * the calldata presence, selector and word count, then the calldata words
 * below that count. Words past the count are skipped and an absent calldata
 * contributes only its absence, so one transaction has one digest whatever
 * the capacity. This is what `calculateRequestId` hashes in place of the
 * parameters of a Tron request.
 *
 * @param txParams - The transaction decomposition to digest, at any capacity.
 * @returns The 32-byte digest.
 * @throws {Error} When the calldata word count exceeds its capacity.
 */
export function calculateTronTxParamsDigest(txParams: TronTxParams): Uint8Array {
  const { calldata } = txParams;
  const noWords = calldata.is_some ? calldata.value.noWords : 0n;
  const selector = calldata.is_some ? calldata.value.selector : new Uint8Array(4);
  if (noWords > BigInt(calldata.value.words.length)) {
    throw new Error("calldata noWords exceeds capacity");
  }
  let acc = transientHash(TRON_DIGEST_HEAD, [
    HashDomain.tronTxHeader,
    txParams.refBlockBytes,
    txParams.refBlockHash,
    txParams.timestamp,
    txParams.expiration,
    txParams.feeLimit,
    txParams.contractAddress,
    txParams.callValue,
    calldata.is_some,
    selector,
    noWords,
  ]);
  for (const word of calldata.value.words.slice(0, Number(noWords))) {
    acc = transientHash(DOMAIN_FIELD_BYTES_32, [HashDomain.tronTxWord, acc, word]);
  }
  return upgradeFromTransient(acc);
}
