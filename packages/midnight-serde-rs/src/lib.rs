//! Rust twin of Compact's builtin `serialize<T, N>` / `deserialize<T, N>`
//! byte layout: produce bytes off-chain that a Midnight contract reads with
//! one `deserialize<T, N>` call, and decode bytes a contract produced with
//! `serialize<T, N>`. Zero runtime dependencies.
//!
//! The layout: struct fields and tuple elements pack in declaration order,
//! every value little-endian at its natural width (bounded uints and enums as
//! wide as their largest legal value), no tags, prefixes or gaps, right
//! zero-padded to `Bytes<N>`.
//!
//! Every claim is pinned against the golden corpus committed in the sibling
//! `midnight-serde-conformance` package, which is itself generated from
//! compiled Compact circuits and Midnight's own `toBinaryRepr` oracle, so
//! this crate, the TypeScript twin and the circuits provably agree byte for
//! byte (see `tests/conformance.rs`).

mod deserialize;
mod error;
mod serialize;
mod types;
mod u256;
mod validate;

pub use deserialize::{DeserializeOptions, deserialize};
pub use error::Error;
pub use serialize::{serialize, serialized_size};
pub use types::{Descriptor, FIELD_MODULUS, MAX_UINT_BITS, MAX_ZERO_WIDTH_ELEMENTS, Value};
pub use u256::U256;
pub use validate::validate;
