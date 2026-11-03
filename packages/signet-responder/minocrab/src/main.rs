//! `cargo run -- <managed-dir> [--update-lock]`: builds the signet
//! responder's zk bundle in `<managed-dir>`, compactc's `--skip-zk` output.
//!
//! The keys come from the `zkir-v3` that ships beside compactc, the one
//! compactc itself runs: beside the compact launcher's default compiler
//! (`~/.compact/bin/compactc`, what `compact compile` runs), else beside the
//! `compactc` on `PATH`. `$ZKIR_V3` overrides it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::Context as _;
use signet_responder_zk::{LockMode, build_bundle};

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let (managed, mode) = match args.as_slice() {
        [managed] => (managed, LockMode::Verify),
        [managed, flag] if flag == "--update-lock" => (managed, LockMode::Update),
        _ => {
            eprintln!("usage: signet-responder-zk <managed-dir> [--update-lock]");
            return ExitCode::FAILURE;
        }
    };
    let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("artifacts.sha256");
    let result =
        zkir_v3().and_then(|zkir_v3| build_bundle(Path::new(managed), &zkir_v3, &lock, mode));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("signet-responder-zk: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn zkir_v3() -> anyhow::Result<PathBuf> {
    if let Some(path) = std::env::var_os("ZKIR_V3") {
        return Ok(PathBuf::from(path));
    }
    let launcher_default =
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".compact/bin/compactc"));
    let path = std::env::var_os("PATH").unwrap_or_default();
    let on_path = std::env::split_paths(&path).map(|dir| dir.join("compactc"));
    let compactc = launcher_default
        .into_iter()
        .chain(on_path)
        .find(|candidate| candidate.is_file())
        .context("no compactc found: install the pinned compact toolchain, or set ZKIR_V3")?;
    let compactc = compactc
        .canonicalize()
        .with_context(|| format!("resolving {}", compactc.display()))?;
    let zkir_v3 = compactc.with_file_name("zkir-v3");
    anyhow::ensure!(
        zkir_v3.is_file(),
        "no zkir-v3 beside {}",
        compactc.display()
    );
    Ok(zkir_v3)
}
