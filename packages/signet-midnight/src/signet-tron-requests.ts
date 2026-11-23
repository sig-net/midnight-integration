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

/** The Tron transaction decomposition of a request (Compact: `TronTriggerSmartContractTxParams`): a TriggerSmartContract call. */
export interface TronTriggerSmartContractTxParams {
  refBlockBytes: Uint8Array;
  refBlockHash: Uint8Array;
  timestamp: bigint;
  expiration: bigint;
  feeLimit: bigint;
  contractAddress: Uint8Array;
  callValue: bigint;
  calldata: Maybe<EvmCalldata>;
}

/**
 * Runtime descriptor of {@link TronTriggerSmartContractTxParams} at a calldata word capacity.
 *
 * @param maxCalldataWords - Calldata word capacity
 * @returns The tx-params descriptor
 */
export function tronTriggerSmartContractTxParamsDescriptor(
  maxCalldataWords: number,
): CompactType<TronTriggerSmartContractTxParams> {
  return compactStructDescriptor<TronTriggerSmartContractTxParams>({
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
 * Runtime descriptor of a Tron request record at the given capacities.
 *
 * @param maxCalldataWords - Calldata word capacity
 * @param lenOutputDeserialization - Declared byte width of `outputDeserializationSchema` (Compact `#LenOutputDeserialization`)
 * @param lenRespondSerialization - Declared byte width of `respondSerializationSchema` (Compact `#LenRespondSerialization`)
 * @returns The event record descriptor
 */
export function tronSignBidirectionalEventDescriptor(
  maxCalldataWords: number,
  lenOutputDeserialization: number,
  lenRespondSerialization: number,
): CompactType<SignBidirectionalEvent<TronTriggerSmartContractTxParams>> {
  return signBidirectionalEventDescriptorWith(
    tronTriggerSmartContractTxParamsDescriptor(maxCalldataWords),
    lenOutputDeserialization,
    lenRespondSerialization,
  );
}

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
 * Digest a Tron decomposition over its used calldata words: the TS twin of the `calculateTronTriggerSmartContractTxParamsDigestV1` circuit.
 *
 * @param txParams - The transaction decomposition to digest, at any capacity
 * @returns The 32-byte digest
 * @throws {Error} When the calldata word count exceeds its capacity
 */
export function calculateTronTriggerSmartContractTxParamsDigest(
  txParams: TronTriggerSmartContractTxParams,
): Uint8Array {
  const { calldata } = txParams;
  const noWords = calldata.is_some ? calldata.value.noWords : 0n;
  const selector = calldata.is_some ? calldata.value.selector : new Uint8Array(4);
  if (noWords > BigInt(calldata.value.words.length)) {
    throw new Error("calldata noWords exceeds capacity");
  }
  let acc = transientHash(TRON_DIGEST_HEAD, [
    HashDomain.tronTriggerSmartContractTxHeader,
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
    acc = transientHash(DOMAIN_FIELD_BYTES_32, [
      HashDomain.tronTriggerSmartContractTxWord,
      acc,
      word,
    ]);
  }
  return upgradeFromTransient(acc);
}
