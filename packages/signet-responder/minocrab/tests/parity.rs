//! The MinoCrab circuits against compactc's compile of
//! `../src/signet-responder.compact` (run `yarn compile` first): they accept
//! the call the MPC makes with identical public inputs, and both reject the
//! calls the Compact source rejects.

use std::path::Path;

use midnight_zkir_v3::IrSource;
use minocrab_publisher::call::{
    Attestation, EcdsaSignature, respond_bidirectional_input, respond_bidirectional_misc,
};
use signet_protocol::circuits::{RESPOND, RESPOND_BIDIRECTIONAL, RESPOND_BIDIRECTIONAL_EVENT};
use signet_responder_zk::{CIRCUITS, Call, check_parity, compactc_circuits, preimage, sample_call};

/// (ours, compactc's) for one circuit.
fn pair(circuit: &str) -> (IrSource, IrSource) {
    let managed = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/managed");
    let reference = compactc_circuits(&managed)
        .unwrap_or_else(|e| panic!("{e:#}"))
        .into_iter()
        .find(|(name, _)| *name == circuit)
        .expect("compactc compiles the circuit")
        .1;
    let ours = CIRCUITS
        .iter()
        .find(|(name, _)| *name == circuit)
        .expect("the circuit has a MinoCrab twin")
        .1()
    .ir;
    (ours, reference)
}

/// Both artifacts reject `call`, so neither the parity gate nor the chain
/// accepts it.
fn assert_both_reject(circuit: &str, call: &Call) {
    let (ours, reference) = pair(circuit);
    let pi = preimage(circuit, call).expect("the call builds");
    assert!(
        minocrab_sim::v3::simulate(&ours, &pi).is_err(),
        "ours accepts the bad {circuit} call"
    );
    assert!(
        minocrab_sim::v3::simulate(&reference, &pi).is_err(),
        "compactc's accepts the bad {circuit} call"
    );
}

#[test]
fn each_circuit_matches_compactcs() {
    for (circuit, _) in CIRCUITS {
        let (ours, reference) = pair(circuit);
        let pi = preimage(circuit, &sample_call(circuit).unwrap()).unwrap();
        check_parity(&ours, &reference, &pi).unwrap_or_else(|e| panic!("{circuit}: {e:#}"));
    }
}

/// An event that does not carry the arguments: one payload byte of the
/// request id flipped.
#[test]
fn an_event_that_misstates_its_arguments_is_rejected() {
    for circuit in [RESPOND, RESPOND_BIDIRECTIONAL] {
        let mut call = sample_call(circuit).unwrap();
        call.misc[40] ^= 0x01;
        assert_both_reject(circuit, &call);
    }
}

/// `outputKind` is a three-variant enum: 3 is not a value of it.
#[test]
fn an_output_kind_past_unviable_is_rejected() {
    let attestation = Attestation {
        block_height: 7,
        output_kind: 3,
        serialized_output_length: 0,
        output_hash: [0x0f; 32],
        digest: [0x0d; 32],
    };
    let signature = EcdsaSignature {
        big_r_x: [0x01; 32],
        big_r_y: [0x02; 32],
        s: [0x03; 32],
        recovery_id: 0,
    };
    let request_id = [0xaa; 32];
    let call = Call {
        input: respond_bidirectional_input(&request_id, &attestation, &signature),
        misc: respond_bidirectional_misc(
            RESPOND_BIDIRECTIONAL_EVENT,
            &request_id,
            &attestation,
            &signature,
        ),
    };
    assert_both_reject(RESPOND_BIDIRECTIONAL, &call);
}

/// The reference must be compactc's own output: a directory whose manifest
/// already lists keys, or whose `.zkir` changed after compactc wrote it, is
/// refused, so a built bundle can never be compared against itself.
#[test]
fn only_fresh_compactc_output_is_a_reference() {
    let fresh = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/managed");
    let scratch = Path::new(env!("CARGO_TARGET_TMPDIR")).join("not-fresh");
    let copy = |name: &str| {
        let dir = scratch.join(name);
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["compiler", "zkir"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
            for entry in std::fs::read_dir(fresh.join(sub)).unwrap() {
                let entry = entry.unwrap();
                std::fs::copy(entry.path(), dir.join(sub).join(entry.file_name())).unwrap();
            }
        }
        dir
    };
    assert!(compactc_circuits(&copy("as-compiled")).is_ok());

    let listed_keys = copy("lists-keys");
    let manifest = listed_keys.join("compiler/contract-manifest.json");
    let text = std::fs::read_to_string(&manifest).unwrap();
    let text = text.trim_end().strip_suffix('}').unwrap().to_string()
        + ",\n  \"keys\": { \"type\": \"directory\" }\n}\n";
    std::fs::write(&manifest, text).unwrap();
    let error = compactc_circuits(&listed_keys).unwrap_err();
    assert!(
        format!("{error:#}").contains("already lists keys"),
        "{error:#}"
    );

    let edited = copy("edited-zkir");
    let zkir = edited.join("zkir/respond.zkir");
    let mut bytes = std::fs::read(&zkir).unwrap();
    bytes.push(b'\n');
    std::fs::write(&zkir, bytes).unwrap();
    let error = compactc_circuits(&edited).unwrap_err();
    assert!(
        format!("{error:#}").contains("differs from its manifest entry"),
        "{error:#}"
    );
}
