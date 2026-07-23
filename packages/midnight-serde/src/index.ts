export {
  FIELD_MODULUS,
  MAX_UINT_BITS,
  MAX_UINT_BOUND,
  type CompactBooleanType,
  type CompactUintType,
  type CompactSizedUintType,
  type CompactBoundedUintType,
  type CompactFieldType,
  type CompactBytesType,
  type CompactEnumType,
  type CompactVectorType,
  type CompactTupleType,
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
