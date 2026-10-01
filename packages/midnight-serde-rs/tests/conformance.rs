use signet_midnight_serde::{BorshDeserialize, BorshSerialize, borsh, deserialize, serialize};

#[derive(Debug, PartialEq, BorshSerialize, BorshDeserialize)]
struct ResultValue {
    ok: bool,
    amount: u128,
}

#[derive(Debug, PartialEq, BorshSerialize, BorshDeserialize)]
struct MaybeValue {
    is_some: bool,
    value: u64,
}

#[derive(Debug, PartialEq, BorshSerialize, BorshDeserialize)]
struct EitherValue {
    is_left: bool,
    left: u16,
    right: [u8; 4],
}

#[derive(Debug, PartialEq, BorshSerialize, BorshDeserialize)]
enum Status {
    Pending,
    Ready,
    Done,
}

fn check<T: BorshSerialize + BorshDeserialize + PartialEq + std::fmt::Debug>(
    value: T,
    expected: &[u8],
) {
    assert_eq!(serialize(&value, None).unwrap(), expected);
    assert_eq!(borsh::to_vec(&value).unwrap(), expected);
    assert_eq!(deserialize::<T>(expected).unwrap(), value);
}

#[test]
fn compact_corpus() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../midnight-serde-conformance/corpus/borsh-corpus.json");
    let records: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(!records.is_empty());
    for record in records {
        let hex = record["hex"].as_str().unwrap();
        let expected: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let value = &record["value"];
        match record["name"].as_str().unwrap() {
            "result" => check(
                ResultValue {
                    ok: value["ok"].as_bool().unwrap(),
                    amount: value["amount"].as_str().unwrap().parse().unwrap(),
                },
                &expected,
            ),
            "u8" => check(u8::MAX, &expected),
            "u16" => check(u16::MAX, &expected),
            "u32" => check(u32::MAX, &expected),
            "u64" => check(u64::MAX, &expected),
            "u128" => check(u128::MAX, &expected),
            "bytes" => check([1u8, 2, 3, 4], &expected),
            "vector" => check([0u16, 256, 65535], &expected),
            "maybe" => check(
                MaybeValue {
                    is_some: value["is_some"].as_bool().unwrap(),
                    value: value["value"].as_str().unwrap().parse().unwrap(),
                },
                &expected,
            ),
            "either" => check(
                EitherValue {
                    is_left: value["is_left"].as_bool().unwrap(),
                    left: 7,
                    right: [1, 2, 3, 4],
                },
                &expected,
            ),
            "enum" => check(Status::Done, &expected),
            name => panic!("Unrecognised corpus case {name}"),
        }
    }
}

#[test]
fn native_types_and_padding() {
    let value = ResultValue {
        ok: true,
        amount: 4242,
    };
    let bytes = serialize(&value, Some(128)).unwrap();
    assert_eq!(bytes.len(), 128);
    assert_eq!(deserialize::<ResultValue>(&bytes).unwrap(), value);
    assert_eq!(&bytes[17..], &[0; 111]);
    assert!(serialize(&value, Some(16)).is_err());
    assert!(deserialize::<ResultValue>(&bytes[..16]).is_err());
    assert_eq!(serialize(&None::<u64>, None).unwrap(), [0]);
    assert_eq!(serialize(&[0u8; 0], None).unwrap(), Vec::<u8>::new());
    assert_eq!(serialize(&vec![7u16], None).unwrap(), [1, 0, 0, 0, 7, 0]);
    assert!(deserialize::<bool>(&[2]).is_err());
    assert_eq!(deserialize::<u8>(&[7, 255]).unwrap(), 7);
    assert_eq!(
        serialize(&-7i64, None).unwrap(),
        borsh::to_vec(&-7i64).unwrap()
    );
}
