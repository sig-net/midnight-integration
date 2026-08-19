//! Byte-exact twin of Compact's builtin `deserialize<T, N>`, mirroring the
//! TypeScript implementation including its two deliberate, strict-by-default
//! divergences from the circuit (both with an opt-out):
//!
//! - PADDING: the circuit IGNORES bytes in the padding region entirely, this
//!   decoder rejects non-zero padding. Set `ignore_padding` to mirror it.
//! - BOOLEANS: the circuit decodes ANY byte other than 0x01 as false, this
//!   decoder rejects bytes above 1. Set `lenient_booleans` to mirror it.
//!
//! Everything else mirrors the circuit exactly, including its rejections:
//! out-of-range Uint, enum and Field encodings all fail exactly where the
//! circuit fails.

use crate::error::Error;
use crate::serialize::{packed_size, uint_bound, width_of_bound};
use crate::types::{Descriptor, FIELD_MODULUS, MAX_ZERO_WIDTH_ELEMENTS, Value};
use crate::u256::U256;
use crate::validate::validate;

/// Opt-outs from the strict defaults: with both set, decoding mirrors the
/// circuit exactly.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeserializeOptions {
    /// Skip the all-zero check on bytes after the packed value.
    pub ignore_padding: bool,
    /// Decode boolean bytes above 0x01 as false, as the circuit does.
    pub lenient_booleans: bool,
}

struct DecodeContext {
    lenient_booleans: bool,
    zero_width_elements: usize,
}

/// Inverse of [`crate::serialize`]: decode the packed prefix of `bytes`.
pub fn deserialize(
    descriptor: &Descriptor,
    bytes: &[u8],
    options: DeserializeOptions,
) -> Result<Value, Error> {
    validate(descriptor)?;
    // One size check up front covers every read below: fields and elements
    // tile the packed prefix exactly.
    let needed = packed_size(descriptor, "type")?;
    if needed > bytes.len() {
        return Err(Error::BufferTooShort {
            needed,
            actual: bytes.len(),
        });
    }
    let mut context = DecodeContext {
        lenient_booleans: options.lenient_booleans,
        zero_width_elements: 0,
    };
    let (value, consumed) = decode_from(bytes, 0, descriptor, "value", &mut context)?;
    if !options.ignore_padding {
        for (i, byte) in bytes.iter().enumerate().skip(consumed) {
            if *byte != 0 {
                return Err(Error::NonZeroPadding {
                    offset: i,
                    byte: *byte,
                });
            }
        }
    }
    Ok(value)
}

fn decode_from(
    bytes: &[u8],
    offset: usize,
    descriptor: &Descriptor,
    path: &str,
    context: &mut DecodeContext,
) -> Result<(Value, usize), Error> {
    match descriptor {
        Descriptor::Boolean => {
            let byte = bytes[offset];
            if byte > 1 && !context.lenient_booleans {
                return Err(Error::InvalidBooleanByte {
                    path: path.to_string(),
                    byte,
                });
            }
            Ok((Value::Bool(byte == 1), offset + 1))
        }
        Descriptor::UintBits { .. } | Descriptor::UintBound { .. } => {
            let bound = uint_bound(descriptor);
            let size = width_of_bound(bound);
            let value = U256::from_le_bytes(&bytes[offset..offset + size]);
            // Mirrors the circuit, which rejects encodings at or above the
            // bound. Reachable for any bounded uint whose max is not
            // all-ones, and for sized uints only at non-byte-aligned widths.
            if value >= bound {
                return Err(Error::UintOutOfRange {
                    path: path.to_string(),
                    value,
                    bound,
                });
            }
            Ok((Value::Uint(value), offset + size))
        }
        Descriptor::Field => {
            let value = U256::from_le_bytes(&bytes[offset..offset + 32]);
            // The circuit rejects out-of-range Field encodings at runtime
            // too: mirror it.
            if value >= FIELD_MODULUS {
                return Err(Error::FieldOutOfRange {
                    path: path.to_string(),
                    value,
                });
            }
            Ok((Value::Field(value), offset + 32))
        }
        Descriptor::Bytes { length } => Ok((
            Value::Bytes(bytes[offset..offset + length].to_vec()),
            offset + length,
        )),
        Descriptor::Enum { variants } => {
            // The width never exceeds 8 bytes (variants - 1 fits u64), so the
            // encoding reads directly into a u64.
            let size = width_of_bound(U256::from_u64(*variants));
            let mut encoding: u64 = 0;
            for (i, byte) in bytes[offset..offset + size].iter().enumerate() {
                encoding |= (*byte as u64) << (i * 8);
            }
            // Mirrors the circuit's variant-index range check.
            if encoding >= *variants {
                return Err(Error::EnumOutOfRange {
                    path: path.to_string(),
                    value: encoding,
                    variants: *variants,
                });
            }
            Ok((Value::Enum(encoding), offset + size))
        }
        Descriptor::Vector { length, element } => {
            if packed_size(element, path)? == 0 {
                // Zero-width elements consume no input, so a hostile
                // descriptor could hang on an empty buffer: cap them.
                context.zero_width_elements += length;
                if context.zero_width_elements > MAX_ZERO_WIDTH_ELEMENTS {
                    return Err(Error::ZeroWidthElementCap {
                        path: path.to_string(),
                        cap: MAX_ZERO_WIDTH_ELEMENTS,
                    });
                }
            }
            let mut elements = Vec::with_capacity(*length);
            let mut cursor = offset;
            for i in 0..*length {
                let (element_value, next) =
                    decode_from(bytes, cursor, element, &format!("{path}[{i}]"), context)?;
                elements.push(element_value);
                cursor = next;
            }
            Ok((Value::Vector(elements), cursor))
        }
        Descriptor::Tuple { elements } => {
            let mut items = Vec::with_capacity(elements.len());
            let mut cursor = offset;
            for (i, element) in elements.iter().enumerate() {
                let (item, next) =
                    decode_from(bytes, cursor, element, &format!("{path}[{i}]"), context)?;
                items.push(item);
                cursor = next;
            }
            Ok((Value::Tuple(items), cursor))
        }
        Descriptor::Struct { fields } => {
            let mut pairs = Vec::with_capacity(fields.len());
            let mut cursor = offset;
            for (name, field) in fields {
                let (field_value, next) =
                    decode_from(bytes, cursor, field, &format!("{path}.{name}"), context)?;
                pairs.push((name.clone(), field_value));
                cursor = next;
            }
            Ok((Value::Struct(pairs), cursor))
        }
    }
}
