//! `respond` and `respondBidirectional`, written in MinoCrab: the same
//! statements as `../src/signet-responder.compact`, emitting the same Misc
//! events, with no ledger fields and no witnesses.
//!
//! ```text
//! respond({ requestId, signature: { bigR: {x, y}, s, recoveryId } }):
//!   emit (Misc { name: pad(32, "SignatureRespondedEvent"),
//!                payload: Bytes[...requestId, ...x, ...y, ...s, recoveryId, ...zeros(127)] })
//! respondBidirectional({ requestId, blockHeight, outputKind, serializedOutputLength,
//!                        outputHash, digest, signature }):
//!   emit (Misc { name: pad(32, "RespondBidirectionalEvent"),
//!                payload: Bytes[...requestId, ...blockHeight as Bytes<8> (LE), outputKind as Uint<8>,
//!                               ...serializedOutputLength as Bytes<8> (LE), ...outputHash, ...digest,
//!                               ...x, ...y, ...s, recoveryId, ...zeros(46)] })
//! ```

use minocrab::v3::{Circuit3, Compiled3, FieldT, Wire3};
use minocrab::{Private, Public};
use minocrab_ledger::{ImpactElem, LedgerValue, emit, emit_event};
use minocrab_std::v3::{B32, Disclose, Discloses, Serializer, contract, label};
use signet_protocol::circuits::{
    RESPOND, RESPOND_BIDIRECTIONAL, RESPOND_BIDIRECTIONAL_EVENT, SIGNATURE_RESPONDED_EVENT,
};
use signet_protocol::misc::{MISC_SIZE, MISC_TAG, MISC_VERSION};
use signet_signer_interface::{RespondBidirectionalEventV1, Signature, SignatureRespondedEventV1};

// Every argument goes into the event payload, so these declarations are the
// circuits' disclosure lists. The labels are the field paths in the argument.
label! {
    EmittedRequestId = "requestId";
    AttestationBlockHeight = "blockHeight";
    AttestationOutputKind = "outputKind";
    AttestationOutputLength = "serializedOutputLength";
    AttestationOutputHash = "outputHash";
    AttestationDigest = "digest";
    SignatureBigRx = "signature.bigR.x";
    SignatureBigRy = "signature.bigR.y";
    SignatureS = "signature.s";
    SignatureRecoveryId = "signature.recoveryId";
}

/// The circuits by their Compact name, which names their files on disk and
/// their entry points on chain.
pub const CIRCUITS: [(&str, fn() -> Compiled3); 2] = [
    (RESPOND, SignetResponder::respond),
    (
        RESPOND_BIDIRECTIONAL,
        SignetResponder::respond_bidirectional,
    ),
];

/// Starts a Misc envelope: `pad(32, name)`.
fn misc_name(c: &mut Circuit3, name: &str) -> Serializer<Public> {
    let mut padded = [0u8; 32];
    padded[..name.len()].copy_from_slice(name.as_bytes());
    let mut s = Serializer::<Public>::new();
    s.push_literal(c, &padded);
    s
}

/// `emit (Misc { name, payload })`: the serializer's bytes, zero-padded to
/// the 288-byte envelope.
fn emit_misc(c: &mut Circuit3, s: Serializer<Public>) {
    // Unused, but removing it renumbers every later identifier and so
    // changes the verifier keys, which match minocrab's own port of these
    // circuits only while it stays.
    let _ = c.constant(1u64);
    let serialized = s.finish::<MISC_SIZE>(c);
    let payload = LedgerValue::bytes(
        MISC_SIZE as u32,
        serialized
            .limbs()
            .iter()
            .map(|&w| ImpactElem::Wire(w))
            .collect(),
    );
    emit(c, &emit_event(MISC_VERSION, MISC_TAG, &payload));
}

/// The signature's four fields, disclosed: `x`, `y`, `s` as `Bytes<32>`,
/// `recoveryId` as a one-byte `Uint<8>`.
struct DisclosedSignature {
    x: B32<Public>,
    y: B32<Public>,
    s: B32<Public>,
    recovery_id: Wire3<FieldT, Public>,
}

fn disclose_signature(c: &mut Circuit3, sig: Signature<Private>) -> DisclosedSignature {
    DisclosedSignature {
        x: sig.big_r.x.disclose_as::<SignatureBigRx>(c),
        y: sig.big_r.y.disclose_as::<SignatureBigRy>(c),
        s: sig.s.disclose_as::<SignatureS>(c),
        recovery_id: sig
            .recovery_id
            .field()
            .disclose_as::<SignatureRecoveryId>(c),
    }
}

impl DisclosedSignature {
    /// x(32) ‖ y(32) ‖ s(32) ‖ recoveryId(1).
    fn push(&self, s: &mut Serializer<Public>) {
        s.push_b32(&self.x);
        s.push_b32(&self.y);
        s.push_b32(&self.s);
        s.push_uint(self.recovery_id, 1);
    }
}

/// The signet responder: two stateless, unauthenticated emit-only circuits.
pub struct SignetResponder;

#[contract]
impl SignetResponder {
    /// `export circuit respond(signatureRespondedEvent:
    /// SignatureRespondedEventV1): []`: nine field limbs.
    #[circuit]
    pub fn respond(
        c: &mut Circuit3,
        signature_responded_event: SignatureRespondedEventV1<Private>,
    ) -> Discloses<(
        EmittedRequestId,
        SignatureBigRx,
        SignatureBigRy,
        SignatureS,
        SignatureRecoveryId,
    )> {
        let event = signature_responded_event;
        let rid = event.request_id.disclose_as::<EmittedRequestId>(c);
        let sig = disclose_signature(c, event.signature);

        // payload: requestId(32) ‖ x(32) ‖ y(32) ‖ s(32) ‖ recoveryId(1) ‖ zeros(127)
        c.region("event serialize + emit", |c| {
            let mut s = misc_name(c, SIGNATURE_RESPONDED_EVENT);
            s.push_b32(&rid.bytes());
            sig.push(&mut s);
            emit_misc(c, s);
        });
        Discloses::of(())
    }

    /// `export circuit respondBidirectional(respondBidirectionalEvent:
    /// RespondBidirectionalEventV1): []`: sixteen field limbs. `outputKind`
    /// is constrained below 3 and emitted as its one-byte variant index; the
    /// two `Uint<64>`s are emitted as eight little-endian bytes each.
    #[circuit]
    pub fn respond_bidirectional(
        c: &mut Circuit3,
        respond_bidirectional_event: RespondBidirectionalEventV1<Private>,
    ) -> Discloses<(
        EmittedRequestId,
        AttestationBlockHeight,
        AttestationOutputKind,
        AttestationOutputLength,
        AttestationOutputHash,
        AttestationDigest,
        SignatureBigRx,
        SignatureBigRy,
        SignatureS,
        SignatureRecoveryId,
    )> {
        let event = respond_bidirectional_event;
        let rid = event.request_id.disclose_as::<EmittedRequestId>(c);
        let height = event
            .block_height
            .field()
            .disclose_as::<AttestationBlockHeight>(c);
        let kind = event
            .output_kind
            .field()
            .disclose_as::<AttestationOutputKind>(c);
        let length = event
            .serialized_output_length
            .field()
            .disclose_as::<AttestationOutputLength>(c);
        let output_hash = event.output_hash.disclose_as::<AttestationOutputHash>(c);
        let digest = event.digest.disclose_as::<AttestationDigest>(c);
        let sig = disclose_signature(c, event.signature);

        // payload: requestId(32) ‖ blockHeight(8, LE) ‖ outputKind(1) ‖
        //          serializedOutputLength(8, LE) ‖ outputHash(32) ‖ digest(32)
        //          ‖ x(32) ‖ y(32) ‖ s(32) ‖ recoveryId(1) ‖ zeros(46)
        c.region("event serialize + emit", |c| {
            let mut s = misc_name(c, RESPOND_BIDIRECTIONAL_EVENT);
            s.push_b32(&rid.bytes());
            s.push_uint(height, 8);
            s.push_uint(kind, 1);
            s.push_uint(length, 8);
            s.push_b32(&output_hash);
            s.push_b32(&digest);
            sig.push(&mut s);
            emit_misc(c, s);
        });
        Discloses::of(())
    }
}
