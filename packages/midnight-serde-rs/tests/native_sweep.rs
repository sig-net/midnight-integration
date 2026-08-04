//! A Rust-native seeded randomised sweep, independent of the corpus: a
//! crate-local generator produces fresh descriptor/value pairs (the corpus
//! already carries the conformance kit's cases) and drives them through
//! size, strict roundtrip and padding checks.

use signet_midnight_serde::{
    Descriptor, DeserializeOptions, FIELD_MODULUS, U256, Value, deserialize, serialize,
    serialized_size, validate,
};

/// xorshift64*: deterministic, seed fixed below.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }
}

fn random_descriptor(rng: &mut Rng, depth: u32) -> Descriptor {
    let kinds = if depth > 0 { 9 } else { 6 };
    match rng.below(kinds) {
        0 => Descriptor::Boolean,
        1 => Descriptor::Field,
        2 => Descriptor::UintBits {
            bits: 1 + rng.below(248) as u32,
        },
        3 => {
            // Bounds across the width range, biased small and always at least 1.
            let bits = rng.below(64) as u32;
            Descriptor::UintBound {
                bound: U256::from_u64(1 + rng.below(1u64 << bits.min(62))),
            }
        }
        4 => Descriptor::Bytes {
            length: rng.below(24) as usize,
        },
        5 => Descriptor::Enum {
            variants: 1 + rng.below(600),
        },
        6 => Descriptor::Vector {
            length: rng.below(4) as usize,
            element: Box::new(random_descriptor(rng, depth - 1)),
        },
        7 => Descriptor::Tuple {
            elements: (0..rng.below(4))
                .map(|_| random_descriptor(rng, depth - 1))
                .collect(),
        },
        _ => Descriptor::Struct {
            fields: (0..rng.below(4))
                .map(|i| (format!("f{i}"), random_descriptor(rng, depth - 1)))
                .collect(),
        },
    }
}

fn random_value(rng: &mut Rng, descriptor: &Descriptor) -> Value {
    match descriptor {
        Descriptor::Boolean => Value::Bool(rng.below(2) == 1),
        Descriptor::Field => {
            // Below the modulus by construction: at most 128 bits.
            let v = U256::from(((rng.next_u64() as u128) << 64) | rng.next_u64() as u128);
            assert!(v < FIELD_MODULUS);
            Value::Field(v)
        }
        Descriptor::UintBits { bits } => {
            // Boundary-biased: 0, max, or a small value.
            let max = U256::pow2(*bits).minus_one();
            Value::Uint(match rng.below(3) {
                0 => U256::ZERO,
                1 => max,
                _ => U256::from_u64(rng.next_u64()).min(max),
            })
        }
        Descriptor::UintBound { bound } => Value::Uint(match rng.below(3) {
            0 => U256::ZERO,
            1 => bound.minus_one(),
            _ => U256::from_u64(rng.next_u64()).min(bound.minus_one()),
        }),
        Descriptor::Bytes { length } => {
            Value::Bytes((0..*length).map(|_| rng.below(256) as u8).collect())
        }
        Descriptor::Enum { variants } => Value::Enum(rng.below(*variants)),
        Descriptor::Vector { length, element } => {
            Value::Vector((0..*length).map(|_| random_value(rng, element)).collect())
        }
        Descriptor::Tuple { elements } => {
            Value::Tuple(elements.iter().map(|e| random_value(rng, e)).collect())
        }
        Descriptor::Struct { fields } => Value::Struct(
            fields
                .iter()
                .map(|(name, field)| (name.clone(), random_value(rng, field)))
                .collect(),
        ),
    }
}

#[test]
fn native_sweep_roundtrips() {
    let mut rng = Rng(0x5eed_5eed_5eed_5eed);
    for case in 0..200 {
        let descriptor = random_descriptor(&mut rng, 3);
        validate(&descriptor).unwrap_or_else(|e| panic!("case {case}: invalid descriptor: {e}"));
        let value = random_value(&mut rng, &descriptor);

        let packed = serialize(&descriptor, &value, None)
            .unwrap_or_else(|e| panic!("case {case}: serialize failed: {e}"));
        let size = serialized_size(&descriptor)
            .unwrap_or_else(|e| panic!("case {case}: size failed: {e}"));
        assert_eq!(packed.len(), size, "case {case}: size mismatch");

        let decoded = deserialize(&descriptor, &packed, DeserializeOptions::default())
            .unwrap_or_else(|e| panic!("case {case}: strict roundtrip failed: {e}"));
        assert_eq!(decoded, value, "case {case}: roundtrip changed the value");

        // Padding: zeros decode strictly, garbage only with ignore_padding.
        let mut padded = serialize(&descriptor, &value, Some(size + 5))
            .unwrap_or_else(|e| panic!("case {case}: padded serialize failed: {e}"));
        assert_eq!(
            deserialize(&descriptor, &padded, DeserializeOptions::default())
                .unwrap_or_else(|e| panic!("case {case}: zero padding rejected: {e}")),
            value
        );
        padded[size + 4] = 0x77;
        let strict = deserialize(&descriptor, &padded, DeserializeOptions::default());
        assert_eq!(
            strict
                .expect_err("garbage padding must reject strictly")
                .category(),
            "padding-nonzero",
            "case {case}"
        );
        let lenient = DeserializeOptions {
            ignore_padding: true,
            ..Default::default()
        };
        assert_eq!(
            deserialize(&descriptor, &padded, lenient)
                .unwrap_or_else(|e| panic!("case {case}: ignore_padding rejected: {e}")),
            value
        );
    }
}
