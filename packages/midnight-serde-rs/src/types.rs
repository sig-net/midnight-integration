//! Runtime descriptors for Compact circuit types and the dynamic value model
//! they map to: the Rust mirror of the TypeScript twin's `CompactType` /
//! `CompactValue` pair. A descriptor tree fully determines the byte layout of
//! Compact's builtin `serialize<T, N>` / `deserialize<T, N>`.

use crate::u256::U256;

/// The BLS12-381 scalar field modulus: a Compact `Field` value is below it.
pub const FIELD_MODULUS: U256 = U256::from_limbs([
    0xffff_ffff_0000_0001,
    0x53bd_a402_fffe_5bfe,
    0x3339_d808_09a1_d805,
    0x73ed_a753_299d_7d48,
]);

/// Maximum `Uint` width accepted by compactc 0.33 (bits).
pub const MAX_UINT_BITS: u32 = 248;

/// Maximum zero-width vector elements a decode will materialise: they consume
/// no input, so a hostile descriptor could otherwise hang on an empty buffer.
pub const MAX_ZERO_WIDTH_ELEMENTS: usize = 65536;

/// A runtime descriptor of a Compact circuit type.
///
/// The `Uint<0..bound>` upper bound is EXCLUSIVE, matching the language:
/// `UintBound { bound: 1000 }` holds 0..999 in 2 bytes, and a bound of 1
/// holds only 0 in ZERO bytes. `UintBits { bits: w }` is the same type as
/// `UintBound { bound: 2^w }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Descriptor {
    /// Compact `Boolean`: 1 byte, 0x00 or 0x01.
    Boolean,
    /// Compact `Uint<bits>` (sized): ceil(bits / 8) bytes little-endian.
    UintBits {
        /// Width in bits, 1..=248.
        bits: u32,
    },
    /// Compact `Uint<0..bound>` (bounded): width is the byte length of
    /// `bound - 1`.
    UintBound {
        /// EXCLUSIVE upper bound, 1..=2^248.
        bound: U256,
    },
    /// Compact `Field`: 32 bytes little-endian, value below
    /// [`FIELD_MODULUS`].
    Field,
    /// Compact `Bytes<length>`: raw bytes, copied verbatim.
    Bytes {
        /// Byte length (0 is legal).
        length: usize,
    },
    /// A Compact enum: the variant index packed like `Uint<0..variants>`.
    Enum {
        /// Variant count, 1 or more. A single-variant enum is ZERO bytes.
        variants: u64,
    },
    /// Compact `Vector<length, element>`: elements back to back, no prefix.
    Vector {
        /// Element count (0 is legal).
        length: usize,
        /// The element descriptor.
        element: Box<Descriptor>,
    },
    /// A Compact tuple `[T1, ..., Tn]`: elements packed in order, exactly
    /// like a struct without field names. The empty tuple is ZERO bytes.
    Tuple {
        /// The element descriptors in order.
        elements: Vec<Descriptor>,
    },
    /// A Compact struct: fields packed in declaration order, no gaps,
    /// flattened. A struct with no fields is ZERO bytes.
    Struct {
        /// The named fields in declaration order.
        fields: Vec<(String, Descriptor)>,
    },
}

/// A dynamic Compact value, shaped by a [`Descriptor`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// A `Boolean` value.
    Bool(bool),
    /// A `Uint` value (either descriptor form).
    Uint(U256),
    /// A `Field` value.
    Field(U256),
    /// An enum variant index.
    Enum(u64),
    /// A `Bytes<n>` value: exactly n bytes.
    Bytes(Vec<u8>),
    /// A `Vector<n, T>` value: exactly n elements.
    Vector(Vec<Value>),
    /// A tuple value: one element per tuple member.
    Tuple(Vec<Value>),
    /// A struct value: named fields. Order need not match the descriptor
    /// (lookup is by name), but every declared field must be present exactly
    /// once and no undeclared field may appear.
    Struct(Vec<(String, Value)>),
}
