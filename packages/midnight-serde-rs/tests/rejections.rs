use signet_midnight_serde::{
    Descriptor, DeserializeOptions, FIELD_MODULUS, SECP256K1_BASE_MODULUS,
    SECP256K1_SCALAR_MODULUS, U256, Value, deserialize, serialize, serialized_size, validate,
};

#[test]
fn invalid_descriptors_fail_every_entry_point() {
    let cases = [
        Descriptor::UintBits { bits: 0 },
        Descriptor::UintBits { bits: 249 },
        Descriptor::UintBound { bound: U256::ZERO },
        Descriptor::UintBound {
            bound: U256::pow2(249),
        },
        Descriptor::Enum { variants: 0 },
        Descriptor::Struct {
            fields: vec![(String::new(), Descriptor::Boolean)],
        },
        Descriptor::Struct {
            fields: vec![
                ("a".into(), Descriptor::Boolean),
                ("a".into(), Descriptor::Field),
            ],
        },
        Descriptor::Vector {
            length: 0,
            element: Box::new(Descriptor::UintBits { bits: 0 }),
        },
    ];
    assert!(!cases.is_empty());
    for descriptor in cases {
        for result in [
            validate(&descriptor),
            serialized_size(&descriptor).map(|_| ()),
            serialize(&descriptor, &Value::Bool(false), None).map(|_| ()),
            deserialize(&descriptor, &[], DeserializeOptions::default()).map(|_| ()),
        ] {
            assert_eq!(
                result.unwrap_err().category(),
                "invalid-descriptor",
                "{descriptor:?}"
            );
        }
    }
}

#[test]
fn invalid_values_fail_with_the_expected_category() {
    let cases = [
        (Descriptor::Boolean, Value::Uint(U256::ZERO), "value-shape"),
        (
            Descriptor::UintBits { bits: 8 },
            Value::Uint(U256::from(256u64)),
            "uint-range",
        ),
        (
            Descriptor::UintBound { bound: U256::ONE },
            Value::Uint(U256::ONE),
            "uint-range",
        ),
        (
            Descriptor::Enum { variants: 3 },
            Value::Enum(3),
            "enum-range",
        ),
        (
            Descriptor::Field,
            Value::Field(FIELD_MODULUS),
            "field-range",
        ),
        (
            Descriptor::Secp256k1Base,
            Value::Secp256k1Base(SECP256K1_BASE_MODULUS),
            "field-range",
        ),
        (
            Descriptor::Secp256k1Scalar,
            Value::Secp256k1Scalar(SECP256K1_SCALAR_MODULUS),
            "field-range",
        ),
        (
            Descriptor::Secp256k1Base,
            Value::Field(U256::ZERO),
            "value-shape",
        ),
        (
            Descriptor::Bytes { length: 2 },
            Value::Bytes(vec![1]),
            "bytes-length",
        ),
        (
            Descriptor::Vector {
                length: 2,
                element: Box::new(Descriptor::Boolean),
            },
            Value::Vector(vec![Value::Bool(true)]),
            "element-count",
        ),
        (
            Descriptor::Tuple {
                elements: vec![Descriptor::Boolean],
            },
            Value::Tuple(vec![]),
            "element-count",
        ),
        (
            Descriptor::Struct {
                fields: vec![("a".into(), Descriptor::Boolean)],
            },
            Value::Struct(vec![]),
            "missing-field",
        ),
        (
            Descriptor::Struct {
                fields: vec![("a".into(), Descriptor::Boolean)],
            },
            Value::Struct(vec![("b".into(), Value::Bool(true))]),
            "unknown-field",
        ),
        (
            Descriptor::Struct {
                fields: vec![("a".into(), Descriptor::Boolean)],
            },
            Value::Struct(vec![
                ("a".into(), Value::Bool(true)),
                ("a".into(), Value::Bool(false)),
            ]),
            "unknown-field",
        ),
    ];
    assert!(!cases.is_empty());
    for (descriptor, value, category) in cases {
        assert_eq!(
            serialize(&descriptor, &value, None).unwrap_err().category(),
            category,
            "{descriptor:?}: {value:?}"
        );
    }
}

#[test]
fn rejects_short_buffers_and_padding_below_the_packed_size() {
    let descriptor = Descriptor::UintBits { bits: 16 };
    assert_eq!(
        deserialize(&descriptor, &[0], DeserializeOptions::default())
            .unwrap_err()
            .category(),
        "short-buffer"
    );
    assert_eq!(
        serialize(&descriptor, &Value::Uint(U256::ZERO), Some(1))
            .unwrap_err()
            .category(),
        "pad-to-below-packed"
    );
}

#[test]
fn rejects_size_overflow_before_allocation() {
    let cases = [
        Descriptor::Vector {
            length: usize::MAX,
            element: Box::new(Descriptor::Field),
        },
        Descriptor::Tuple {
            elements: vec![
                Descriptor::Bytes { length: usize::MAX },
                Descriptor::Boolean,
            ],
        },
    ];
    assert!(!cases.is_empty());
    for descriptor in cases {
        assert_eq!(
            serialized_size(&descriptor).unwrap_err().category(),
            "size-overflow"
        );
        assert_eq!(
            deserialize(&descriptor, &[], DeserializeOptions::default())
                .unwrap_err()
                .category(),
            "size-overflow"
        );
        assert_eq!(
            serialize(&descriptor, &Value::Tuple(vec![]), None)
                .unwrap_err()
                .category(),
            "size-overflow"
        );
    }
}
