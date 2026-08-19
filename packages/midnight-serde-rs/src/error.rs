//! The structured error model. Every rejection carries the path to the
//! offending node and exposes a language-neutral category slug matching the
//! conformance corpus, so tests (and cross-language consumers) never couple
//! to message strings.

use std::fmt;

use crate::u256::U256;

/// Every way `serialize`, `deserialize` or `validate` can fail.
#[derive(Debug)]
pub enum Error {
    /// A descriptor failed structural validation.
    InvalidDescriptor { path: String, reason: String },
    /// A value's shape does not match its descriptor.
    ValueShape {
        path: String,
        expected: &'static str,
    },
    /// A Uint value or encoding at or above its exclusive bound.
    UintOutOfRange {
        path: String,
        value: U256,
        bound: U256,
    },
    /// An enum variant index or encoding at or above the variant count.
    EnumOutOfRange {
        path: String,
        value: u64,
        variants: u64,
    },
    /// A Field value or encoding at or above the BLS12-381 scalar modulus.
    FieldOutOfRange { path: String, value: U256 },
    /// A strict-mode boolean byte above 0x01 (the circuit decodes these as
    /// false: pass `lenient_booleans` to mirror it).
    InvalidBooleanByte { path: String, byte: u8 },
    /// A strict-mode non-zero byte in the padding region (the circuit
    /// ignores padding entirely: pass `ignore_padding` to mirror it).
    NonZeroPadding { offset: usize, byte: u8 },
    /// The input buffer is shorter than the descriptor's packed size.
    BufferTooShort { needed: usize, actual: usize },
    /// A byte-array value whose length does not match `Bytes<n>`.
    BytesLength {
        path: String,
        expected: usize,
        actual: usize,
    },
    /// A vector or tuple value whose element count does not match.
    ElementCount {
        path: String,
        expected: usize,
        actual: usize,
    },
    /// A struct value with a field the descriptor does not declare.
    UnknownField { path: String, field: String },
    /// A struct value missing a declared field.
    MissingField { path: String, field: String },
    /// A packed size that overflowed usize arithmetic.
    SizeOverflow { path: String },
    /// `pad_to` below the packed size (a compile error in Compact too).
    PadToBelowPacked { pad_to: usize, packed: usize },
    /// Refusal to materialise a huge number of zero-width vector elements
    /// (they decode from no input at all, so a hostile descriptor could
    /// otherwise hang the process).
    ZeroWidthElementCap { path: String, cap: usize },
}

impl Error {
    /// The language-neutral rejection category slug used by the conformance
    /// corpus. Categories the corpus does not exercise get their own stable
    /// slugs anyway, so the mapping is total.
    pub fn category(&self) -> &'static str {
        match self {
            Error::InvalidDescriptor { .. } => "invalid-descriptor",
            Error::ValueShape { .. } => "value-shape",
            Error::UintOutOfRange { .. } => "uint-range",
            Error::EnumOutOfRange { .. } => "enum-range",
            Error::FieldOutOfRange { .. } => "field-range",
            Error::InvalidBooleanByte { .. } => "boolean-strict",
            Error::NonZeroPadding { .. } => "padding-nonzero",
            Error::BufferTooShort { .. } => "short-buffer",
            Error::BytesLength { .. } => "bytes-length",
            Error::ElementCount { .. } => "element-count",
            Error::UnknownField { .. } => "unknown-field",
            Error::MissingField { .. } => "missing-field",
            Error::SizeOverflow { .. } => "size-overflow",
            Error::PadToBelowPacked { .. } => "pad-to-below-packed",
            Error::ZeroWidthElementCap { .. } => "zero-width-cap",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidDescriptor { path, reason } => {
                write!(f, "{path}: invalid descriptor: {reason}")
            }
            Error::ValueShape { path, expected } => write!(f, "{path}: expected {expected}"),
            Error::UintOutOfRange { path, value, bound } => {
                write!(f, "{path}: value {value} is not below the bound {bound}")
            }
            Error::EnumOutOfRange {
                path,
                value,
                variants,
            } => {
                write!(
                    f,
                    "{path}: variant index {value} is outside 0..{}",
                    variants - 1
                )
            }
            Error::FieldOutOfRange { path, value } => {
                write!(f, "{path}: value {value} is not below the Field modulus")
            }
            Error::InvalidBooleanByte { path, byte } => {
                write!(f, "{path}: invalid boolean byte 0x{byte:02x}")
            }
            Error::NonZeroPadding { offset, byte } => {
                write!(f, "non-zero padding byte 0x{byte:02x} at offset {offset}")
            }
            Error::BufferTooShort { needed, actual } => {
                write!(f, "needs {needed} bytes, buffer has {actual}")
            }
            Error::BytesLength {
                path,
                expected,
                actual,
            } => {
                write!(f, "{path}: expected exactly {expected} bytes, got {actual}")
            }
            Error::ElementCount {
                path,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "{path}: expected exactly {expected} elements, got {actual}"
                )
            }
            Error::UnknownField { path, field } => {
                write!(f, "{path}: unknown field '{field}' (not in the descriptor)")
            }
            Error::MissingField { path, field } => {
                write!(f, "{path}: missing field '{field}'")
            }
            Error::SizeOverflow { path } => {
                write!(f, "{path}: packed size exceeds usize")
            }
            Error::PadToBelowPacked { pad_to, packed } => {
                write!(
                    f,
                    "pad_to {pad_to} is below the packed size {packed} (a compile error in Compact too)"
                )
            }
            Error::ZeroWidthElementCap { path, cap } => {
                write!(
                    f,
                    "{path}: refusing to materialise over {cap} zero-width vector elements"
                )
            }
        }
    }
}

impl std::error::Error for Error {}
