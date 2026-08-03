//! Byte-exact twin of Compact's builtin `serialize<T, N>`, mirroring the
//! TypeScript implementation rule for rule.
//!
//! Layout: struct fields and tuple elements pack in declaration order, every
//! value little-endian at its NATURAL width (bounded uints and enums as wide
//! as their largest legal value, so a bound of 1 and single-variant enums are
//! ZERO bytes), the packed value at the START of `Bytes<N>`, zero-padded on
//! the right. `pad_to` below the packed size is an error, matching the
//! Compact compile error.

use crate::error::Error;
use crate::types::{Descriptor, FIELD_MODULUS, Value};
use crate::u256::U256;
use crate::validate::validate;

/// The EXCLUSIVE upper bound of a uint descriptor, whichever form it uses.
pub(crate) fn uint_bound(descriptor: &Descriptor) -> U256 {
    match descriptor {
        Descriptor::UintBits { bits } => U256::pow2(*bits),
        Descriptor::UintBound { bound } => *bound,
        _ => unreachable!("uint_bound on a non-uint descriptor"),
    }
}

/// Byte length of the largest legal value, given the EXCLUSIVE bound.
pub(crate) fn width_of_bound(bound: U256) -> usize {
    bound.minus_one().byte_length()
}

/// Packed byte size of an ALREADY-VALIDATED descriptor (crate-internal: the
/// public [`serialized_size`] validates first).
pub(crate) fn packed_size(descriptor: &Descriptor, path: &str) -> Result<usize, Error> {
    match descriptor {
        Descriptor::Boolean => Ok(1),
        Descriptor::UintBits { .. } | Descriptor::UintBound { .. } => {
            Ok(width_of_bound(uint_bound(descriptor)))
        }
        Descriptor::Field => Ok(32),
        Descriptor::Bytes { length } => Ok(*length),
        Descriptor::Enum { variants } => Ok(width_of_bound(U256::from_u64(*variants))),
        Descriptor::Vector { length, element } => {
            let element_size = packed_size(element, path)?;
            length
                .checked_mul(element_size)
                .ok_or_else(|| Error::SizeOverflow {
                    path: path.to_string(),
                })
        }
        Descriptor::Tuple { elements } => {
            let mut total: usize = 0;
            for element in elements {
                total = total
                    .checked_add(packed_size(element, path)?)
                    .ok_or_else(|| Error::SizeOverflow {
                        path: path.to_string(),
                    })?;
            }
            Ok(total)
        }
        Descriptor::Struct { fields } => {
            let mut total: usize = 0;
            for (_, field) in fields {
                total = total
                    .checked_add(packed_size(field, path)?)
                    .ok_or_else(|| Error::SizeOverflow {
                        path: path.to_string(),
                    })?;
            }
            Ok(total)
        }
    }
}

/// Packed byte size of a type, before `serialize<T, N>`'s right zero-padding.
pub fn serialized_size(descriptor: &Descriptor) -> Result<usize, Error> {
    validate(descriptor)?;
    packed_size(descriptor, "type")
}

/// Byte-exact twin of `serialize<T, pad_to>(value)`. With `pad_to` `None`
/// the packed value is returned unpadded, matching `serialize<T, packed>`.
/// Every value is range- and shape-checked: out-of-range numerics, wrong
/// lengths, and struct fields the descriptor does not declare all fail.
pub fn serialize(
    descriptor: &Descriptor,
    value: &Value,
    pad_to: Option<usize>,
) -> Result<Vec<u8>, Error> {
    validate(descriptor)?;
    let packed = packed_size(descriptor, "type")?;
    let total = pad_to.unwrap_or(packed);
    if total < packed {
        return Err(Error::PadToBelowPacked {
            pad_to: total,
            packed,
        });
    }
    let mut out = vec![0u8; total];
    let written = encode_into(&mut out, 0, descriptor, value, "value")?;
    debug_assert_eq!(written, packed);
    Ok(out)
}

fn encode_into(
    out: &mut [u8],
    offset: usize,
    descriptor: &Descriptor,
    value: &Value,
    path: &str,
) -> Result<usize, Error> {
    match descriptor {
        Descriptor::Boolean => {
            let Value::Bool(b) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "boolean",
                });
            };
            out[offset] = u8::from(*b);
            Ok(offset + 1)
        }
        Descriptor::UintBits { .. } | Descriptor::UintBound { .. } => {
            let Value::Uint(v) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "uint",
                });
            };
            let bound = uint_bound(descriptor);
            let size = width_of_bound(bound);
            if *v >= bound {
                return Err(Error::UintOutOfRange {
                    path: path.to_string(),
                    value: *v,
                    bound,
                });
            }
            v.write_le(&mut out[offset..offset + size]);
            Ok(offset + size)
        }
        Descriptor::Field => {
            let Value::Field(v) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "field",
                });
            };
            if *v >= FIELD_MODULUS {
                return Err(Error::FieldOutOfRange {
                    path: path.to_string(),
                    value: *v,
                });
            }
            v.write_le(&mut out[offset..offset + 32]);
            Ok(offset + 32)
        }
        Descriptor::Bytes { length } => {
            let Value::Bytes(bytes) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "bytes",
                });
            };
            if bytes.len() != *length {
                return Err(Error::BytesLength {
                    path: path.to_string(),
                    expected: *length,
                    actual: bytes.len(),
                });
            }
            out[offset..offset + length].copy_from_slice(bytes);
            Ok(offset + length)
        }
        Descriptor::Enum { variants } => {
            let Value::Enum(index) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "enum index",
                });
            };
            let size = width_of_bound(U256::from_u64(*variants));
            if index >= variants {
                return Err(Error::EnumOutOfRange {
                    path: path.to_string(),
                    value: *index,
                    variants: *variants,
                });
            }
            U256::from_u64(*index).write_le(&mut out[offset..offset + size]);
            Ok(offset + size)
        }
        Descriptor::Vector { length, element } => {
            let Value::Vector(elements) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "vector",
                });
            };
            if elements.len() != *length {
                return Err(Error::ElementCount {
                    path: path.to_string(),
                    expected: *length,
                    actual: elements.len(),
                });
            }
            let mut cursor = offset;
            for (i, item) in elements.iter().enumerate() {
                cursor = encode_into(out, cursor, element, item, &format!("{path}[{i}]"))?;
            }
            Ok(cursor)
        }
        Descriptor::Tuple { elements } => {
            let Value::Tuple(items) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "tuple",
                });
            };
            if items.len() != elements.len() {
                return Err(Error::ElementCount {
                    path: path.to_string(),
                    expected: elements.len(),
                    actual: items.len(),
                });
            }
            let mut cursor = offset;
            for (i, (element, item)) in elements.iter().zip(items).enumerate() {
                cursor = encode_into(out, cursor, element, item, &format!("{path}[{i}]"))?;
            }
            Ok(cursor)
        }
        Descriptor::Struct { fields } => {
            let Value::Struct(pairs) = value else {
                return Err(Error::ValueShape {
                    path: path.to_string(),
                    expected: "struct",
                });
            };
            // Reject unknown keys, mirroring the twin's strictness: a typo'd
            // extra entry alongside the correct ones would otherwise vanish.
            for (name, _) in pairs {
                if !fields.iter().any(|(declared, _)| declared == name) {
                    return Err(Error::UnknownField {
                        path: path.to_string(),
                        field: name.clone(),
                    });
                }
            }
            let mut cursor = offset;
            for (name, field) in fields {
                let mut found = pairs.iter().filter(|(n, _)| n == name);
                let Some((_, field_value)) = found.next() else {
                    return Err(Error::MissingField {
                        path: path.to_string(),
                        field: name.clone(),
                    });
                };
                if found.next().is_some() {
                    return Err(Error::UnknownField {
                        path: path.to_string(),
                        field: format!("{name} (duplicated)"),
                    });
                }
                cursor = encode_into(out, cursor, field, field_value, &format!("{path}.{name}"))?;
            }
            Ok(cursor)
        }
    }
}
