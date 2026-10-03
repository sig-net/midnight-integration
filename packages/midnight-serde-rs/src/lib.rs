//! Native Borsh serialisation with optional zero padding for Midnight callers.
//! Compact compatibility depends on the caller's type choices, documented in the README.

pub use borsh::{self, BorshDeserialize, BorshSerialize};
use std::io::{self, Error, ErrorKind};

/// Serialise a native Borsh value, optionally extending its encoding with zeros.
///
/// Returns an error when Borsh fails or the requested length is too small.
pub fn serialize<T: BorshSerialize + ?Sized>(
    value: &T,
    length: Option<usize>,
) -> io::Result<Vec<u8>> {
    let mut bytes = borsh::to_vec(value)?;
    if let Some(length) = length {
        if length < bytes.len() {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "Output length is smaller than the Borsh encoding",
            ));
        }
        bytes.resize(length, 0);
    }
    Ok(bytes)
}

/// Decode one native Borsh value from the start of the buffer.
///
/// Uses Borsh's reader API so trailing padding is left unread.
/// Returns the native Borsh decoding error for malformed input.
pub fn deserialize<T: BorshDeserialize>(bytes: &[u8]) -> io::Result<T> {
    T::deserialize_reader(&mut &bytes[..])
}
