//! Compactc's `--skip-zk` compile of `../src/signet-responder.compact`, made
//! by the tests themselves in a directory of their own.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// The compile, run once per test binary into its own directory under the
/// target's tmp, so `yarn compile:zk` rewriting `../src/managed` never
/// reaches it.
pub fn compactc_output() -> &'static Path {
    static OUTPUT: OnceLock<PathBuf> = OnceLock::new();
    OUTPUT.get_or_init(|| {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(concat!("compactc-", env!("CARGO_CRATE_NAME")));
        let _ = std::fs::remove_dir_all(&dir);
        // Must match the package's `compile` script, whose output the bundle
        // build reads.
        let output = Command::new("compact")
            .current_dir(&package)
            .env("COMPACT_PATH", "../../node_modules")
            .args(["compile", "--skip-zk", "src/signet-responder.compact"])
            .arg(&dir)
            .output()
            .unwrap_or_else(|e| {
                panic!("running `compact compile` (install the pinned compact toolchain): {e}")
            });
        assert!(
            output.status.success(),
            "`compact compile --skip-zk` exited {}:\n{}{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        dir
    })
}
