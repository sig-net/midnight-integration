/**
 * Signet Standard Library for Midnight
 *
 * Standardized interface for Compact contracts to communicate signing
 * requests to the Signet MPC, mirroring Hydration's pallet_signet.
 */

export { encodeLengthPrefixed, decodeLengthPrefixed, encodeString, decodeString } from './codec';

export {
  CALLDATA_FUNC_SIG_SIZE,
  CAIP2_ID_SIZE,
  PATH_SIZE,
  ALGO_SIZE,
  DEST_SIZE,
  PARAMS_SIZE,
  OUTPUT_SCHEMA_SIZE,
  RESPOND_SCHEMA_SIZE,
  ECDSA,
  ETHEREUM,
  DEFAULT_KEY_VERSION,
  FIELD_NAMES,
  caip2Evm,
} from './constants';

export type { RequestIdFields } from './request-id';
export { computeRequestId, calldataArgKey, computeCalldataArgsCommitment } from './request-id';

export type { SignetLedger, SignetMap } from './state-reader';
export { readRequest, readAllRequests, readCalldataArgs, matchesMpcPubKeyHash } from './state-reader';

export type { EvmTxParams } from './tx-builder';
export { buildUnsignedEip1559Tx, buildErc20TransferData } from './tx-builder';

export { buildCalldata, buildTransactionFromRequest } from './calldata-builder';

export type {
  SigningRequest,
  MonitoredContract,
  BlockStreamConfig,
  SigningResponse,
  EvmGasParams,
  CalldataFields,
} from './types';

export type { SchnorrSignature, SchnorrChallengeFn } from './schnorr';
export {
  JUBJUB_ORDER,
  BLS_ORDER,
  schnorrSign,
  schnorrVerify,
  buildSignetMessage,
  deriveJubjubKeypair,
  hashJubjubPoint,
  bigintToBytes32,
  bytesToBigint,
} from './schnorr';
