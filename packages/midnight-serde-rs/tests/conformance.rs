//! Replays every record of the committed golden corpus
//! (../midnight-serde-conformance/corpus/serde-corpus.jsonl) through this
//! crate. The corpus is generated from compiled Compact circuits, Midnight's
//! toBinaryRepr oracle and the TypeScript twin (which replays it too), so a
//! green run proves this crate agrees with all of them byte for byte, with no
//! JS toolchain anywhere near `cargo test`.
//!
//! Struct fields in JSON values are read in DESCRIPTOR order, never JSON key
//! order. Rejections are matched by the corpus's language-neutral category
//! slugs via `Error::category`, never by message strings.

use std::path::Path;

use serde_json::Value as Json;
use signet_midnight_serde::{
    Descriptor, DeserializeOptions, U256, Value, deserialize, serialize, serialized_size,
};

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("corpus hex"))
        .collect()
}

fn json_to_descriptor(json: &Json) -> Descriptor {
    let kind = json["kind"].as_str().expect("descriptor kind");
    match kind {
        "boolean" => Descriptor::Boolean,
        "field" => Descriptor::Field,
        "uint" => match json.get("bits") {
            Some(bits) => Descriptor::UintBits {
                bits: bits.as_u64().expect("bits") as u32,
            },
            None => Descriptor::UintBound {
                bound: U256::from_dec_str(json["bound"].as_str().expect("bound string"))
                    .expect("bound value"),
            },
        },
        "bytes" => Descriptor::Bytes {
            length: json["length"].as_u64().expect("length") as usize,
        },
        "enum" => Descriptor::Enum {
            variants: json["variants"].as_u64().expect("variants"),
        },
        "vector" => Descriptor::Vector {
            length: json["length"].as_u64().expect("length") as usize,
            element: Box::new(json_to_descriptor(&json["element"])),
        },
        "tuple" => Descriptor::Tuple {
            elements: json["elements"]
                .as_array()
                .expect("elements")
                .iter()
                .map(json_to_descriptor)
                .collect(),
        },
        "struct" => Descriptor::Struct {
            fields: json["fields"]
                .as_array()
                .expect("fields")
                .iter()
                .map(|f| {
                    (
                        f["name"].as_str().expect("field name").to_string(),
                        json_to_descriptor(&f["type"]),
                    )
                })
                .collect(),
        },
        other => panic!("unknown descriptor kind {other}"),
    }
}

fn json_to_value(descriptor: &Descriptor, json: &Json) -> Value {
    match descriptor {
        Descriptor::Boolean => Value::Bool(json.as_bool().expect("bool")),
        Descriptor::UintBits { .. } | Descriptor::UintBound { .. } => {
            Value::Uint(U256::from_dec_str(json.as_str().expect("uint string")).expect("uint"))
        }
        Descriptor::Field => {
            Value::Field(U256::from_dec_str(json.as_str().expect("field string")).expect("field"))
        }
        Descriptor::Bytes { .. } => Value::Bytes(hex_decode(json.as_str().expect("bytes hex"))),
        Descriptor::Enum { .. } => Value::Enum(json.as_u64().expect("enum index")),
        Descriptor::Vector { element, .. } => Value::Vector(
            json.as_array()
                .expect("vector")
                .iter()
                .map(|e| json_to_value(element, e))
                .collect(),
        ),
        Descriptor::Tuple { elements } => Value::Tuple(
            elements
                .iter()
                .zip(json.as_array().expect("tuple"))
                .map(|(element, e)| json_to_value(element, e))
                .collect(),
        ),
        Descriptor::Struct { fields } => Value::Struct(
            fields
                .iter()
                .map(|(name, field)| (name.clone(), json_to_value(field, &json[name.as_str()])))
                .collect(),
        ),
    }
}

fn value_to_json(descriptor: &Descriptor, value: &Value) -> Json {
    match (descriptor, value) {
        (Descriptor::Boolean, Value::Bool(b)) => Json::from(*b),
        (Descriptor::UintBits { .. } | Descriptor::UintBound { .. }, Value::Uint(v)) => {
            Json::from(v.to_string())
        }
        (Descriptor::Field, Value::Field(v)) => Json::from(v.to_string()),
        (Descriptor::Bytes { .. }, Value::Bytes(b)) => Json::from(hex_encode(b)),
        (Descriptor::Enum { .. }, Value::Enum(i)) => Json::from(*i),
        (Descriptor::Vector { element, .. }, Value::Vector(items)) => Json::from(
            items
                .iter()
                .map(|i| value_to_json(element, i))
                .collect::<Vec<_>>(),
        ),
        (Descriptor::Tuple { elements }, Value::Tuple(items)) => Json::from(
            elements
                .iter()
                .zip(items)
                .map(|(e, i)| value_to_json(e, i))
                .collect::<Vec<_>>(),
        ),
        (Descriptor::Struct { fields }, Value::Struct(pairs)) => {
            let mut map = serde_json::Map::new();
            for (name, field) in fields {
                let field_value = &pairs
                    .iter()
                    .find(|(n, _)| n == name)
                    .expect("decoded field present")
                    .1;
                map.insert(name.clone(), value_to_json(field, field_value));
            }
            Json::Object(map)
        }
        _ => panic!("value/descriptor shape mismatch in value_to_json"),
    }
}

/// The respond-schema vocabulary of SignBidirectionalEvent's ABI-style JSON
/// schemas (outputDeserializationSchema / respondSerializationSchema), as an
/// INDEPENDENT Rust implementation of schema -> descriptor: the corpus's
/// `schema` records carry descriptors derived by the production TypeScript
/// mapping (@sig-net/midnight's abi-serde), so matching them here proves two
/// implementations of the mapping agree, on top of the byte agreement.
///
/// On-chain schemas live in fixed-width Bytes<N> fields, so the text is cut
/// at the first NUL before JSON parsing.
fn schema_to_descriptor(schema: &str) -> Descriptor {
    let text = schema
        .split('\0')
        .next()
        .expect("split yields at least one element");
    let fields: Vec<Json> = serde_json::from_str(text).expect("schema JSON");
    Descriptor::Struct {
        fields: fields
            .iter()
            .map(|field| {
                let name = field["name"]
                    .as_str()
                    .expect("schema field name")
                    .to_string();
                let ty = field["type"].as_str().expect("schema field type");
                (name, schema_field_descriptor(ty, field))
            })
            .collect(),
    }
}

fn schema_field_descriptor(ty: &str, field: &Json) -> Descriptor {
    // Dynamic string/bytes: 8-byte LE length + payload zero-padded to maxBytes.
    if ty == "string" || ty == "bytes" {
        let max_bytes = field["maxBytes"].as_u64().expect("maxBytes") as usize;
        return Descriptor::Struct {
            fields: vec![
                ("len".to_string(), Descriptor::UintBits { bits: 64 }),
                ("data".to_string(), Descriptor::Bytes { length: max_bytes }),
            ],
        };
    }
    // Arrays: 8-byte LE count + maxItems elements at the element's width.
    if let Some(element) = ty.strip_suffix("[]") {
        let max_items = field["maxItems"].as_u64().expect("maxItems") as usize;
        return Descriptor::Struct {
            fields: vec![
                ("len".to_string(), Descriptor::UintBits { bits: 64 }),
                (
                    "items".to_string(),
                    Descriptor::Vector {
                        length: max_items,
                        element: Box::new(schema_fixed_descriptor(element)),
                    },
                ),
            ],
        };
    }
    schema_fixed_descriptor(ty)
}

fn schema_fixed_descriptor(ty: &str) -> Descriptor {
    match ty {
        "bool" => Descriptor::Boolean,
        // uint256, address and field all ride the Compact Field carrier.
        "field" | "uint256" | "address" => Descriptor::Field,
        _ => {
            if let Some(bits) = ty.strip_prefix("uint").and_then(|b| b.parse::<u32>().ok()) {
                assert!(
                    (8..=248).contains(&bits) && bits % 8 == 0,
                    "uint width {bits} outside the respond vocabulary"
                );
                return Descriptor::UintBits { bits };
            }
            if let Some(n) = ty
                .strip_prefix("bytes")
                .and_then(|b| b.parse::<usize>().ok())
            {
                assert!(
                    (1..=32).contains(&n),
                    "bytes{n} outside the respond vocabulary"
                );
                return Descriptor::Bytes { length: n };
            }
            panic!("unsupported schema type '{ty}'")
        }
    }
}

fn record_options(record: &Json) -> DeserializeOptions {
    let options = record.get("options");
    DeserializeOptions {
        ignore_padding: options
            .and_then(|o| o.get("ignorePadding"))
            .and_then(Json::as_bool)
            .unwrap_or(false),
        lenient_booleans: options
            .and_then(|o| o.get("lenientBooleans"))
            .and_then(Json::as_bool)
            .unwrap_or(false),
    }
}

#[test]
fn corpus_conformance() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../midnight-serde-conformance/corpus/serde-corpus.jsonl");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read the golden corpus at {}: {e}", path.display()));

    let mut failures: Vec<String> = Vec::new();
    let mut counts = (0usize, 0usize, 0usize);
    let mut schema_count = 0usize;
    // The exact literal test-caller-contract.compact carries as Bytes<34>:
    // the corpus MUST exercise it verbatim.
    let mut saw_contract_literal = false;

    for line in text.lines().filter(|l| !l.is_empty()) {
        let record: Json = serde_json::from_str(line).expect("corpus line is JSON");
        let name = record["name"].as_str().unwrap_or("<header>").to_string();
        let mut fail = |message: String| failures.push(format!("{name}: {message}"));

        match record["record"].as_str().expect("record kind") {
            "header" => {
                if record["schema"].as_u64() != Some(1) {
                    fail(format!("unsupported corpus schema {}", record["schema"]));
                }
            }
            "serialize" | "sweep" => {
                counts.0 += 1;
                let descriptor = json_to_descriptor(&record["type"]);
                let value = json_to_value(&descriptor, &record["value"]);
                let packed_hex = record["packed"].as_str().expect("packed");

                match serialized_size(&descriptor) {
                    Ok(size) if size * 2 == packed_hex.len() => {}
                    Ok(size) => fail(format!(
                        "serialized_size {size} disagrees with packed length {}",
                        packed_hex.len() / 2
                    )),
                    Err(e) => fail(format!("serialized_size failed: {e}")),
                }
                match serialize(&descriptor, &value, None) {
                    Ok(packed) if hex_encode(&packed) == packed_hex => {}
                    Ok(packed) => fail(format!(
                        "packed {} != expected {packed_hex}",
                        hex_encode(&packed)
                    )),
                    Err(e) => fail(format!("serialize failed: {e}")),
                }
                if let Some(n) = record.get("n").and_then(Json::as_u64) {
                    let expected = format!(
                        "{packed_hex}{}",
                        "00".repeat(n as usize - packed_hex.len() / 2)
                    );
                    match serialize(&descriptor, &value, Some(n as usize)) {
                        Ok(padded) if hex_encode(&padded) == expected => {}
                        Ok(padded) => fail(format!("padded {} != expected", hex_encode(&padded))),
                        Err(e) => fail(format!("padded serialize failed: {e}")),
                    }
                }
                // Sweep records additionally pin the strict roundtrip and the
                // padding trio (zeros fine, garbage rejects, garbage passes
                // with ignore_padding).
                if record["record"] == "sweep" {
                    let packed = hex_decode(packed_hex);
                    match deserialize(&descriptor, &packed, DeserializeOptions::default()) {
                        Ok(decoded) if decoded == value => {}
                        Ok(_) => fail("strict roundtrip returned a different value".to_string()),
                        Err(e) => fail(format!("strict roundtrip failed: {e}")),
                    }
                    let mut padded = packed.clone();
                    padded.extend_from_slice(&[0, 0, 0]);
                    if let Err(e) = deserialize(&descriptor, &padded, DeserializeOptions::default())
                    {
                        fail(format!("zero padding rejected: {e}"));
                    }
                    let garbage_at = padded.len() - 1;
                    padded[garbage_at] = 0xfe;
                    match deserialize(&descriptor, &padded, DeserializeOptions::default()) {
                        Err(e) if e.category() == "padding-nonzero" => {}
                        Err(e) => fail(format!("garbage padding wrong category {}", e.category())),
                        Ok(_) => fail("garbage padding accepted strictly".to_string()),
                    }
                    let ignore = DeserializeOptions {
                        ignore_padding: true,
                        ..Default::default()
                    };
                    if let Err(e) = deserialize(&descriptor, &padded, ignore) {
                        fail(format!(
                            "garbage padding rejected despite ignore_padding: {e}"
                        ));
                    }
                }
            }
            "schema" => {
                schema_count += 1;
                let schema = record["schema"].as_str().expect("schema string");
                if schema == "[{\"name\":\"success\",\"type\":\"bool\"}]" {
                    saw_contract_literal = true;
                }
                // Derive the descriptor from the schema string OURSELVES and
                // cross-check against the production mapping's recorded one.
                let descriptor = schema_to_descriptor(schema);
                let recorded = json_to_descriptor(&record["type"]);
                if descriptor != recorded {
                    fail(format!(
                        "schema mapping disagrees with the recorded descriptor: {descriptor:?} vs {recorded:?}"
                    ));
                    continue;
                }
                let value = json_to_value(&descriptor, &record["value"]);
                let packed_hex = record["packed"].as_str().expect("packed");
                match serialize(&descriptor, &value, None) {
                    Ok(packed) if hex_encode(&packed) == packed_hex => {}
                    Ok(packed) => fail(format!(
                        "packed {} != expected {packed_hex}",
                        hex_encode(&packed)
                    )),
                    Err(e) => fail(format!("serialize failed: {e}")),
                }
                match deserialize(
                    &descriptor,
                    &hex_decode(packed_hex),
                    DeserializeOptions::default(),
                ) {
                    Ok(decoded) if decoded == value => {}
                    Ok(_) => fail("roundtrip returned a different value".to_string()),
                    Err(e) => fail(format!("roundtrip failed: {e}")),
                }
            }
            "deserialize" => {
                counts.1 += 1;
                let descriptor = json_to_descriptor(&record["type"]);
                let bytes = hex_decode(record["bytes"].as_str().expect("bytes"));
                let options = record_options(&record);
                let result = deserialize(&descriptor, &bytes, options);
                if let Some(expected) = record["expect"].get("value") {
                    match result {
                        Ok(decoded) if &value_to_json(&descriptor, &decoded) == expected => {}
                        Ok(decoded) => fail(format!(
                            "decoded {} != expected {expected}",
                            value_to_json(&descriptor, &decoded)
                        )),
                        Err(e) => fail(format!("decode failed: {e}")),
                    }
                } else {
                    let category = record["expect"]["reject"]
                        .as_str()
                        .expect("reject category");
                    match result {
                        Err(e) if e.category() == category => {}
                        Err(e) => fail(format!(
                            "rejected with category '{}', expected '{category}' ({e})",
                            e.category()
                        )),
                        Ok(_) => fail(format!("accepted bytes expected to reject as {category}")),
                    }
                }
            }
            other => fail(format!("unknown record kind {other}")),
        }
        counts.2 += 1;
    }

    // A structural change must never silently blind this harness.
    assert!(
        counts.2 > 400,
        "corpus suspiciously small: {} records",
        counts.2
    );
    assert!(counts.0 > 0 && counts.1 > 0, "corpus missing record kinds");
    assert!(schema_count > 0, "corpus carries no schema records");
    assert!(
        saw_contract_literal,
        "corpus lost the verbatim test-caller-contract schema literal"
    );
    assert!(
        failures.is_empty(),
        "{} corpus failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
