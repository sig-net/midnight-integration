use signet_midnight_serde::{
    Descriptor, DeserializeOptions, Error, MAX_ZERO_WIDTH_ELEMENTS, U256, Value, deserialize,
};

#[test]
fn write_le_zero_fills_the_output_tail() {
    let cases = [
        (U256::ZERO, vec![]),
        (U256::ONE, vec![1]),
        (U256::ONE, [vec![1], vec![0; 31]].concat()),
        (U256::ONE, [vec![1], vec![0; 32]].concat()),
        (U256::ONE, [vec![1], vec![0; 63]].concat()),
        (
            U256::from_limbs([u64::MAX; 4]),
            [vec![255; 32], vec![0]].concat(),
        ),
    ];
    for (value, expected) in cases {
        let mut output = vec![0xaa; expected.len()];
        value.write_le(&mut output);
        assert_eq!(output, expected, "value {value}");
    }
}

#[test]
fn zero_width_vectors_reject_lengths_above_the_remaining_budget() {
    for (first, second) in [
        (1, usize::MAX),
        (0, usize::MAX),
        (1, MAX_ZERO_WIDTH_ELEMENTS),
        (MAX_ZERO_WIDTH_ELEMENTS, 1),
    ] {
        let descriptor = Descriptor::Tuple {
            elements: vec![
                Descriptor::Vector {
                    length: first,
                    element: Box::new(Descriptor::Bytes { length: 0 }),
                },
                Descriptor::Vector {
                    length: second,
                    element: Box::new(Descriptor::Bytes { length: 0 }),
                },
            ],
        };
        let error = deserialize(&descriptor, &[], DeserializeOptions::default()).unwrap_err();
        assert!(
            matches!(error, Error::ZeroWidthElementCap { ref path, cap }
                if path == "value[1]" && cap == MAX_ZERO_WIDTH_ELEMENTS),
            "lengths {first}, {second}: {error}"
        );
    }
}

#[test]
fn zero_width_vectors_accept_the_exact_combined_budget() {
    let descriptor = Descriptor::Tuple {
        elements: vec![
            Descriptor::Vector {
                length: 1,
                element: Box::new(Descriptor::Bytes { length: 0 }),
            },
            Descriptor::Vector {
                length: MAX_ZERO_WIDTH_ELEMENTS - 1,
                element: Box::new(Descriptor::Bytes { length: 0 }),
            },
        ],
    };
    assert_eq!(
        deserialize(&descriptor, &[], DeserializeOptions::default()).unwrap(),
        Value::Tuple(vec![
            Value::Vector(vec![Value::Bytes(vec![])]),
            Value::Vector(vec![Value::Bytes(vec![]); MAX_ZERO_WIDTH_ELEMENTS - 1]),
        ])
    );
}
