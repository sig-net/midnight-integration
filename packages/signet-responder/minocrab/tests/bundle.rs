//! The bundle builder against compactc's compile of
//! `../src/signet-responder.compact` (run `yarn compile` first). A stand-in
//! keygen replaces zkir-v3, so these pin what the builder does with its
//! output; `yarn compile:zk` runs the real one against the committed lock.

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};

use minocrab_publisher::call::hex;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use signet_responder_zk::{LockMode, build_bundle, compactc_circuits};

/// A copy of compactc's fresh output (`yarn compile` writes it), so a test
/// cannot touch the real one. Each test passes its own `name`, so tests
/// running in parallel never share a directory.
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

/// A stand-in for `zkir-v3 compile-many <zkir-dir> <key-dir>` that runs
/// `body` as a shell script.
fn fake_zkir_v3(name: &str, body: &str) -> PathBuf {
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn manifest(managed: &Path) -> Value {
    let path = managed.join("compiler/contract-manifest.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// Every generated artifact lands in the lock and in the manifest
/// midnight-js checks it against, with its real size and hash, and the
/// manifest's compactc entries survive the rewrite.
#[test]
fn a_build_lists_every_artifact_in_the_lock_and_the_manifest() {
    let managed = fresh_copy("built");
    let before = manifest(&managed);
    let zkir_v3 = fake_zkir_v3(
        "fixed-keygen",
        r#"mkdir -p "$3"
for c in respond respondBidirectional; do
  printf "bzkir $c" > "$2/$c.bzkir"
  printf "prover $c" > "$3/$c.prover"
  printf "verifier $c" > "$3/$c.verifier"
done"#,
    );
    let lock = Path::new(env!("CARGO_TARGET_TMPDIR")).join("built.sha256");

    build_bundle(&managed, &zkir_v3, &lock, LockMode::Update).unwrap();

    let locked = std::fs::read_to_string(&lock).unwrap();
    let files: Vec<&str> = locked.lines().map(|line| &line[66..]).collect();
    assert_eq!(
        files,
        [
            "zkir/respond.zkir",
            "zkir/respond.bzkir",
            "keys/respond.prover",
            "keys/respond.verifier",
            "zkir/respondBidirectional.zkir",
            "zkir/respondBidirectional.bzkir",
            "keys/respondBidirectional.prover",
            "keys/respondBidirectional.verifier",
        ]
    );
    let after = manifest(&managed);
    for line in locked.lines() {
        let (hash, file) = (&line[..64], &line[66..]);
        let bytes = std::fs::read(managed.join(file)).unwrap();
        assert_eq!(hash, sha256_hex(&bytes), "{file}");
        let (dir, name) = file.split_once('/').unwrap();
        assert_eq!(
            after[dir][name],
            json!({ "type": "file", "size": bytes.len(), "hash": hash }),
            "{file}"
        );
    }
    assert_eq!(
        after["zkir"].as_object().unwrap().len(),
        5,
        "type + 4 files"
    );
    assert_eq!(
        after["keys"].as_object().unwrap().len(),
        5,
        "type + 4 files"
    );
    for field in [
        "manifest-version",
        "compiler-version",
        "compiler-commit",
        "compiler",
        "contract",
    ] {
        assert_eq!(after[field], before[field], "{field}");
    }

    // The build is reproducible against its lock, and a built bundle is no
    // longer a reference.
    let again = fresh_copy("built-again");
    build_bundle(&again, &zkir_v3, &lock, LockMode::Verify).unwrap();
    let error = build_bundle(&managed, &zkir_v3, &lock, LockMode::Verify).unwrap_err();
    assert!(
        format!("{error:#}").contains("already lists keys"),
        "{error:#}"
    );
}

/// zkir-v3 creates each key file before it runs that circuit's keygen, so a
/// keygen that fails part way leaves files the package build would accept.
#[test]
fn a_failed_keygen_leaves_no_keys() {
    let managed = fresh_copy("failed-keygen");
    let zkir_v3 = fake_zkir_v3(
        "failing-keygen",
        "mkdir -p \"$3\" && : > \"$3/respond.prover\"\nexit 1",
    );
    let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("artifacts.sha256");

    let error = build_bundle(&managed, &zkir_v3, &lock, LockMode::Verify).unwrap_err();

    assert!(format!("{error:#}").contains("compile-many"), "{error:#}");
    assert!(!managed.join("keys").exists(), "the partial keys survived");
}

/// The reference must be compactc's own output: a `.zkir` changed after
/// compactc wrote it is refused. A built bundle, whose manifest lists keys,
/// is refused too (the end of the lock and manifest test above).
#[test]
fn only_fresh_compactc_output_is_a_reference() {
    assert!(compactc_circuits(&fresh_copy("as-compiled")).is_ok());

    let edited = fresh_copy("edited-zkir");
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

/// Every circuit passes parity before any file changes: when the second
/// fails, the first's compactc `.zkir` is still there.
#[test]
fn a_parity_failure_writes_nothing() {
    let managed = fresh_copy("parity-failure");
    // compactc's `respond` in place of its `respondBidirectional`, with the
    // manifest updated to vouch for it, fails respondBidirectional's parity.
    let respond = std::fs::read(managed.join("zkir/respond.zkir")).unwrap();
    std::fs::write(managed.join("zkir/respondBidirectional.zkir"), &respond).unwrap();
    let path = managed.join("compiler/contract-manifest.json");
    let mut vouched = manifest(&managed);
    vouched["zkir"]["respondBidirectional.zkir"] =
        json!({ "type": "file", "size": respond.len(), "hash": sha256_hex(&respond) });
    std::fs::write(&path, serde_json::to_string_pretty(&vouched).unwrap()).unwrap();
    let zkir_v3 = fake_zkir_v3("unreached-keygen", "exit 1");
    let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("artifacts.sha256");

    let error = build_bundle(&managed, &zkir_v3, &lock, LockMode::Verify).unwrap_err();

    assert!(
        format!("{error:#}").contains("respondBidirectional fails parity"),
        "{error:#}"
    );
    assert_eq!(
        std::fs::read(managed.join("zkir/respond.zkir")).unwrap(),
        respond
    );
}

/// A manifest field the builder does not know is refused rather than
/// dropped when the manifest is rewritten.
#[test]
fn an_unknown_manifest_field_is_refused() {
    let managed = fresh_copy("unknown-field");
    let path = managed.join("compiler/contract-manifest.json");
    let mut extended = manifest(&managed);
    extended["contract"]["index.js"]["mode"] = json!("0644");
    std::fs::write(&path, serde_json::to_string_pretty(&extended).unwrap()).unwrap();

    let error = compactc_circuits(&managed).unwrap_err();

    assert!(format!("{error:#}").contains("unknown field"), "{error:#}");
}
