//! The MinoCrab circuits against compactc's compile of
//! `../src/signet-responder.compact`: both reject the calls the Compact source
//! rejects. That they accept the MPC's call with identical public inputs is
//! the bundle build's own gate (`tests/bundle.rs`).

mod common;

use midnight_zkir_v3::IrSource;
use minocrab_publisher::call::{
    Attestation, EcdsaSignature, respond_bidirectional_input, respond_bidirectional_misc,
};
use signet_protocol::circuits::{RESPOND, RESPOND_BIDIRECTIONAL, RESPOND_BIDIRECTIONAL_EVENT};
use signet_responder_zk::{
    COMPACT_CIRCUITS, Call, check_parity, compactc_circuits, preimage, sample_call,
};

/// (ours, compactc's) for one circuit.
fn pair(circuit: &str) -> (IrSource, IrSource) {
    let reference = compactc_circuits(common::compactc_output())
        .unwrap_or_else(|e| panic!("{e:#}"))
        .into_iter()
        .find(|(name, _)| *name == circuit)
        .expect("compactc compiles the circuit")
        .1;
    let ours = COMPACT_CIRCUITS
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

/// `outputKind` is a three-variant enum: 2 (`unviable`) is its last value,
/// and 3 is not a value of it. The same call is accepted at 2, so the
/// rejection at 3 is the kind's and nothing else's.
#[test]
fn an_output_kind_past_unviable_is_rejected() {
    let call = |output_kind: u8| {
        let attestation = Attestation {
            block_height: 7,
            output_kind,
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
        Call {
            input: respond_bidirectional_input(&request_id, &attestation, &signature),
            misc: respond_bidirectional_misc(
                RESPOND_BIDIRECTIONAL_EVENT,
                &request_id,
                &attestation,
                &signature,
            ),
        }
    };

    let (ours, reference) = pair(RESPOND_BIDIRECTIONAL);
    let unviable = preimage(RESPOND_BIDIRECTIONAL, &call(2)).unwrap();
    check_parity(&ours, &reference, &unviable).unwrap_or_else(|e| panic!("{e:#}"));

    assert_both_reject(RESPOND_BIDIRECTIONAL, &call(3));
}
