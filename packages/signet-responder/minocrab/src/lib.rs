//! The signet responder's circuits in MinoCrab, the parity gate that ties
//! them to `../src/signet-responder.compact`, and the zk bundle compiled from
//! them.

mod bundle;
mod circuits;
mod parity;

pub use bundle::{LockMode, build_bundle, compactc_circuits};
pub use circuits::{COMPACT_CIRCUITS, SignetResponder};
pub use parity::{Call, check_parity, preimage, sample_call};
