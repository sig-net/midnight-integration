//! A crate-local 256-bit unsigned integer: four u64 limbs, little-endian.
//! Compact values top out at 255 bits (`Field` is below the BLS12-381 scalar
//! modulus, `Uint` at 248 bits), so 256 bits cover every representable value
//! and every legal bound (up to 2^248 inclusive) with zero dependencies.

use std::cmp::Ordering;
use std::fmt;

/// 256-bit unsigned integer, little-endian limbs (`limbs[0]` least
/// significant).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct U256 {
    limbs: [u64; 4],
}

impl U256 {
    /// The value 0.
    pub const ZERO: U256 = U256 { limbs: [0; 4] };

    /// The value 1.
    pub const ONE: U256 = U256 {
        limbs: [1, 0, 0, 0],
    };

    /// Construct from raw little-endian limbs.
    pub const fn from_limbs(limbs: [u64; 4]) -> U256 {
        U256 { limbs }
    }

    /// Construct from a u64.
    pub const fn from_u64(value: u64) -> U256 {
        U256 {
            limbs: [value, 0, 0, 0],
        }
    }

    /// The value `2^bit`. Panics if `bit >= 256` (a caller bug: validated
    /// descriptors keep bits at 248 or below).
    pub fn pow2(bit: u32) -> U256 {
        assert!(bit < 256, "pow2 exponent out of range");
        let mut limbs = [0u64; 4];
        limbs[(bit / 64) as usize] = 1u64 << (bit % 64);
        U256 { limbs }
    }

    /// Whether the value is 0.
    pub fn is_zero(&self) -> bool {
        self.limbs == [0; 4]
    }

    /// Parse a non-negative decimal string. Returns `None` on an empty
    /// string, a non-digit character, or overflow past 2^256.
    pub fn from_dec_str(text: &str) -> Option<U256> {
        if text.is_empty() {
            return None;
        }
        let mut value = U256::ZERO;
        for c in text.chars() {
            let digit = c.to_digit(10)? as u64;
            value = value.checked_mul_small(10)?.checked_add_small(digit)?;
        }
        Some(value)
    }

    /// Multiply by a small factor, `None` on overflow.
    fn checked_mul_small(self, factor: u64) -> Option<U256> {
        let mut carry: u128 = 0;
        let mut limbs = [0u64; 4];
        for (i, limb) in self.limbs.iter().enumerate() {
            let product = (*limb as u128) * (factor as u128) + carry;
            limbs[i] = product as u64;
            carry = product >> 64;
        }
        if carry != 0 {
            None
        } else {
            Some(U256 { limbs })
        }
    }

    /// Add a small addend, `None` on overflow.
    fn checked_add_small(self, addend: u64) -> Option<U256> {
        let mut carry: u128 = addend as u128;
        let mut limbs = [0u64; 4];
        for (i, limb) in self.limbs.iter().enumerate() {
            let sum = (*limb as u128) + carry;
            limbs[i] = sum as u64;
            carry = sum >> 64;
        }
        if carry != 0 {
            None
        } else {
            Some(U256 { limbs })
        }
    }

    /// Subtract 1. Panics on 0 (a caller bug: bounds are validated at 1 or
    /// above before width computation, the only caller).
    pub fn minus_one(self) -> U256 {
        assert!(!self.is_zero(), "minus_one on zero");
        let mut limbs = self.limbs;
        for limb in limbs.iter_mut() {
            if *limb == 0 {
                *limb = u64::MAX;
            } else {
                *limb -= 1;
                break;
            }
        }
        U256 { limbs }
    }

    /// The minimal number of bytes needed to represent the value (0 for 0).
    pub fn byte_length(&self) -> usize {
        for i in (0..4).rev() {
            if self.limbs[i] != 0 {
                let limb_bytes = 8 - (self.limbs[i].leading_zeros() as usize) / 8;
                return i * 8 + limb_bytes;
            }
        }
        0
    }

    /// Read a little-endian byte slice (at most 32 bytes) into a value.
    /// Panics on longer input (a caller bug: widths are computed before
    /// reads and never exceed 32).
    pub fn from_le_bytes(bytes: &[u8]) -> U256 {
        assert!(bytes.len() <= 32, "from_le_bytes input too long");
        let mut limbs = [0u64; 4];
        for (i, byte) in bytes.iter().enumerate() {
            limbs[i / 8] |= (*byte as u64) << ((i % 8) * 8);
        }
        U256 { limbs }
    }

    /// Write the value little-endian into `out`, zero-filling the tail.
    /// Panics if the value does not fit (callers range-check first).
    pub fn write_le(&self, out: &mut [u8]) {
        assert!(
            self.byte_length() <= out.len(),
            "write_le: value does not fit the target width"
        );
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = (self.limbs[i / 8] >> ((i % 8) * 8)) as u8;
        }
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &U256) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &U256) -> Ordering {
        // Little-endian limbs: compare from the most significant limb down.
        for i in (0..4).rev() {
            match self.limbs[i].cmp(&other.limbs[i]) {
                Ordering::Equal => continue,
                unequal => return unequal,
            }
        }
        Ordering::Equal
    }
}

impl fmt::Display for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Repeated division by 10^19 (the largest power of ten in a u64).
        const CHUNK: u64 = 10_000_000_000_000_000_000;
        if self.is_zero() {
            return f.write_str("0");
        }
        let mut limbs = self.limbs;
        let mut chunks: Vec<u64> = Vec::new();
        while limbs != [0; 4] {
            let mut remainder: u128 = 0;
            for i in (0..4).rev() {
                let dividend = (remainder << 64) | (limbs[i] as u128);
                limbs[i] = (dividend / (CHUNK as u128)) as u64;
                remainder = dividend % (CHUNK as u128);
            }
            chunks.push(remainder as u64);
        }
        let mut text = chunks.pop().unwrap_or(0).to_string();
        for chunk in chunks.iter().rev() {
            text.push_str(&format!("{chunk:019}"));
        }
        f.write_str(&text)
    }
}

impl From<u64> for U256 {
    fn from(value: u64) -> U256 {
        U256::from_u64(value)
    }
}

impl From<u128> for U256 {
    fn from(value: u128) -> U256 {
        U256 {
            limbs: [value as u64, (value >> 64) as u64, 0, 0],
        }
    }
}
