//! The parity gate: our circuit and compactc's accept the same call and
//! derive the same public inputs from it.
//!
//! The call is built the way the MPC builds a respond: `minocrab-publisher`'s
//! arguments and Push/Log program, partitioned against an empty contract
//! state, then put through the ledger's own `Intent::new`, which computes the
//! communication commitment and constructs the proof preimage.

use anyhow::{Context as _, bail, ensure};
use midnight_base_crypto::fab::AlignedValue;
use midnight_base_crypto::hash::HashOutput;
use midnight_base_crypto::time::Timestamp;
use midnight_coin_structure::contract::ContractAddress;
use midnight_ledger::structure::{
    ContractAction, INITIAL_PARAMETERS, Intent, ProofPreimageMarker, ProofPreimageVersioned,
    Signature,
};
use midnight_storage::db::InMemoryDB;
use midnight_transient_crypto::commitment::PedersenRandomness;
use midnight_transient_crypto::proofs::{ProofPreimage, Zkir as _};
use midnight_zkir_v3::IrSource;
use minocrab::Fr;
use minocrab_publisher::call::{
    Attestation, EcdsaSignature, call_prototype, empty_state, respond_bidirectional_input,
    respond_bidirectional_misc, respond_input, respond_misc,
};
use rand::SeedableRng as _;
use rand::rngs::StdRng;
use signet_protocol::circuits::{
    RESPOND, RESPOND_BIDIRECTIONAL, RESPOND_BIDIRECTIONAL_EVENT, SIGNATURE_RESPONDED_EVENT,
};

/// One call's arguments and the 288-byte Misc envelope its event carries.
pub struct Call {
    pub input: AlignedValue,
    pub misc: Vec<u8>,
}

/// A call of `circuit` whose every field is distinct and non-zero, so a
/// circuit that reads one field in place of another cannot pass.
///
/// # Errors
/// If `circuit` is not one of the responder's circuits.
pub fn sample_call(circuit: &str) -> anyhow::Result<Call> {
    let filled = |seed: u8| -> [u8; 32] {
        std::array::from_fn(|i| seed.wrapping_add(i as u8).wrapping_mul(13))
    };
    let request_id = filled(0x9c);
    let signature = EcdsaSignature {
        big_r_x: filled(0x11),
        big_r_y: filled(0x47),
        s: filled(0xa3),
        recovery_id: 1,
    };
    match circuit {
        RESPOND => Ok(Call {
            input: respond_input(&request_id, &signature),
            misc: respond_misc(SIGNATURE_RESPONDED_EVENT, &request_id, &signature),
        }),
        RESPOND_BIDIRECTIONAL => {
            // `failed` (variant 1), so a confusion with `executed` shows, and a
            // height and width with every byte live.
            let attestation = Attestation {
                block_height: 0x0102_0304_0506_0708,
                output_kind: 1,
                serialized_output_length: 0x1112_1314_1516_1718,
                output_hash: filled(0x5c),
                digest: filled(0xd1),
            };
            Ok(Call {
                input: respond_bidirectional_input(&request_id, &attestation, &signature),
                misc: respond_bidirectional_misc(
                    RESPOND_BIDIRECTIONAL_EVENT,
                    &request_id,
                    &attestation,
                    &signature,
                ),
            })
        }
        other => bail!("the signet responder has no circuit named {other:?}"),
    }
}

/// The ledger's own proof preimage for `call` to `circuit`.
///
/// The address and randomness are fixed: neither enters the statement the
/// circuit proves.
///
/// # Errors
/// If the publisher cannot partition the call's program.
pub fn preimage(circuit: &str, call: &Call) -> anyhow::Result<ProofPreimage> {
    let prototype = call_prototype(
        circuit,
        ContractAddress(HashOutput([0x5a; 32])),
        &empty_state::<InMemoryDB>(),
        &INITIAL_PARAMETERS,
        call.input.clone(),
        &call.misc,
        Fr::from(0x516_e37u64),
    )
    .with_context(|| format!("building the {circuit} call"))?;
    let mut rng = StdRng::seed_from_u64(0x5169_6e65_7400);
    let intent: Intent<Signature, ProofPreimageMarker, PedersenRandomness, InMemoryDB> =
        Intent::new(
            &mut rng,
            None,
            None,
            vec![prototype],
            vec![],
            vec![],
            None,
            Timestamp::from_secs(3600),
        );
    let mut calls = intent
        .actions
        .iter_deref()
        .filter_map(|action| match action {
            ContractAction::Call(call) => Some(call.proof.clone()),
            _ => None,
        });
    match (calls.next(), calls.next()) {
        (Some(ProofPreimageVersioned::V2(preimage)), None) => Ok((*preimage).clone()),
        (Some(other), None) => bail!("{circuit}: unexpected proof preimage version {other:?}"),
        _ => bail!("{circuit}: one prototype must make exactly one call"),
    }
}

/// Fails unless `ours` and `reference` are interchangeable on `preimage`:
/// the same input and output schemas, both accept it, and minocrab's
/// simulator derives the same public inputs from both. The upstream checker
/// must accept each too, and agree with the simulator on which public inputs
/// each skips.
///
/// # Errors
/// On the first difference, or if either artifact rejects the preimage.
pub fn check_parity(
    ours: &IrSource,
    reference: &IrSource,
    preimage: &ProofPreimage,
) -> anyhow::Result<()> {
    let input_types = |ir: &IrSource| -> anyhow::Result<Vec<serde_json::Value>> {
        let inputs = serde_json::to_value(&ir.inputs)?;
        let inputs = inputs.as_array().context("the input schema is a list")?;
        Ok(inputs.iter().map(|input| input["type"].clone()).collect())
    };
    ensure!(
        input_types(ours)? == input_types(reference)?,
        "the input schemas differ"
    );
    ensure!(
        ours.outputs == reference.outputs,
        "the output schemas differ"
    );

    let our_run = minocrab_sim::v3::simulate(ours, preimage).context("ours rejects the call")?;
    let their_run =
        minocrab_sim::v3::simulate(reference, preimage).context("compactc's rejects the call")?;
    ensure!(our_run.pis == their_run.pis, "the public inputs differ");
    ensure!(
        our_run.pi_skips == their_run.pi_skips,
        "the skipped public inputs differ"
    );

    for (who, ir, run) in [
        ("ours", ours, &our_run),
        ("compactc's", reference, &their_run),
    ] {
        let checked = ir
            .check(preimage)
            .with_context(|| format!("the upstream checker rejects {who}"))?;
        ensure!(
            checked == run.pi_skips,
            "the upstream checker and the simulator disagree on {who}"
        );
    }
    Ok(())
}
