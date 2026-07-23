export {
  FIELD_MODULUS,
  MAX_UINT_BITS,
  type CompactBooleanType,
  type CompactUintType,
  type CompactFieldType,
  type CompactBytesType,
  type CompactVectorType,
  type CompactStructType,
  type CompactType,
  type CompactValue,
  type CompactValueOf,
} from './types.ts';

export { compactSerialize, compactSerializedSize } from './serialize.ts';

export { assertCompactType, isCompactType } from './validate.ts';

export {
  compactDeserialize,
  type CompactDeserializeOptions,
} from './deserialize.ts';
