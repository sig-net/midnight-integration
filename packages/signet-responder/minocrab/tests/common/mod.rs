//! Fixtures shared by the integration tests. Each test passes its own name,
//! so tests running in parallel never share a directory.

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};

/// A copy of compactc's fresh output (`yarn compile` writes it), so a test
/// cannot touch the real one.
pub fn fresh_copy(name: &str) -> PathBuf {
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
pub fn fake_zkir_v3(name: &str, body: &str) -> PathBuf {
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}
