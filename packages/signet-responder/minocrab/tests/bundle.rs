//! The bundle builder against compactc's compile of
//! `../src/signet-responder.compact` (run `yarn compile` first).

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};

use signet_responder_zk::{LockMode, build_bundle};

/// A copy of compactc's fresh output, so the build cannot touch the real one.
fn fresh_copy(name: &str) -> PathBuf {
    let fresh = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/managed");
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["compiler", "zkir"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
        for entry in std::fs::read_dir(fresh.join(sub)).unwrap() {
            let entry = entry.unwrap();
            std::fs::copy(entry.path(), dir.join(sub).join(entry.file_name())).unwrap();
        }
    }
    dir
}

/// zkir-v3 creates each key file before it runs that circuit's keygen, so a
/// keygen that fails part way leaves files the package build would accept.
#[test]
fn a_failed_keygen_leaves_no_keys() {
    let managed = fresh_copy("failed-keygen");
    let zkir_v3 = Path::new(env!("CARGO_TARGET_TMPDIR")).join("failing-zkir-v3");
    std::fs::write(
        &zkir_v3,
        "#!/bin/sh\nmkdir -p \"$3\" && : > \"$3/respond.prover\"\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&zkir_v3, std::fs::Permissions::from_mode(0o755)).unwrap();
    let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("artifacts.sha256");

    let error = build_bundle(&managed, &zkir_v3, &lock, LockMode::Verify).unwrap_err();

    assert!(format!("{error:#}").contains("compile-many"), "{error:#}");
    assert!(!managed.join("keys").exists(), "the partial keys survived");
}
