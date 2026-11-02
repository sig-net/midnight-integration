//! Turns compactc's `--skip-zk` output into a complete zk bundle built from
//! the MinoCrab circuits.
//!
//! The bundle keeps compactc's layout, so midnight-js and the MPC read it
//! unchanged: compactc's `contract/` executor and `compiler/` info, our
//! `zkir/<circuit>.{zkir,bzkir}` and `keys/<circuit>.{prover,verifier}`, and
//! `compiler/contract-manifest.json` re-listing `zkir/` and `keys/` with the
//! sizes and hashes of what now sits there, which midnight-js checks every
//! artifact against before it proves.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::process::Command;

use anyhow::{Context as _, bail, ensure};
use midnight_zkir_v3::IrSource;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::circuits::CIRCUITS;
use crate::parity::{check_parity, preimage, sample_call};

const MANIFEST: &str = "compiler/contract-manifest.json";

/// `compiler/contract-manifest.json`, field for field in compactc's order.
/// An unknown field fails the parse rather than being dropped on rewrite.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Manifest {
    manifest_version: String,
    compiler_version: String,
    language_version: String,
    runtime_version: String,
    compiler: Directory,
    contract: Directory,
    zkir: Directory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    keys: Option<Directory>,
}

/// One manifest directory: `"type": "directory"`, then its files by name.
#[derive(Serialize, Deserialize)]
struct Directory {
    r#type: String,
    #[serde(flatten)]
    files: BTreeMap<String, Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    r#type: String,
    size: u64,
    hash: String,
}

impl Directory {
    /// The manifest listing of `files`, read from `managed`.
    fn of(managed: &Path, dir: &str, files: &[String]) -> anyhow::Result<Directory> {
        let mut entries = BTreeMap::new();
        for file in files
            .iter()
            .filter(|file| file.starts_with(&format!("{dir}/")))
        {
            let bytes = read(&managed.join(file))?;
            let name = file[dir.len() + 1..].to_string();
            let entry = Entry {
                r#type: "file".into(),
                size: bytes.len() as u64,
                hash: sha256_hex(&bytes),
            };
            entries.insert(name, entry);
        }
        Ok(Directory {
            r#type: "directory".into(),
            files: entries,
        })
    }
}

/// What to do with the lock file of artifact hashes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockMode {
    /// Fail if the generated artifacts differ from the lock.
    Verify,
    /// Rewrite the lock from the generated artifacts.
    Update,
}

/// Builds the bundle in `managed`, which must hold fresh
/// `compact compile --skip-zk` output of `signet-responder.compact`.
///
/// Each circuit must first pass [`check_parity`] against compactc's `.zkir`
/// of it. Then our `.zkir` replaces compactc's, `zkir-v3 compile-many`
/// writes the `.bzkir` and the keys, the artifacts are checked against (or
/// written to) `lock`, and the manifest is rewritten.
///
/// # Errors
/// If `managed` is not fresh compactc output, a circuit fails parity,
/// `zkir-v3` fails, or the artifacts differ from `lock` under
/// [`LockMode::Verify`].
pub fn build_bundle(
    managed: &Path,
    zkir_v3: &Path,
    lock: &Path,
    mode: LockMode,
) -> anyhow::Result<()> {
    let manifest_path = managed.join(MANIFEST);
    let mut manifest = read_manifest(&manifest_path)?;
    let zkir_dir = managed.join("zkir");
    let key_dir = managed.join("keys");
    for (name, reference) in compactc_circuits(managed)? {
        let ours = CIRCUITS
            .iter()
            .find(|(circuit, _)| *circuit == name)
            .map(|(_, build)| build().ir)
            .context("every compactc circuit has a MinoCrab twin")?;
        let call = sample_call(name)?;
        check_parity(&ours, &reference, &preimage(name, &call)?)
            .with_context(|| format!("{name} fails parity with compactc's circuit"))?;
        let path = zkir_dir.join(format!("{name}.zkir"));
        let file =
            std::fs::File::create(&path).with_context(|| format!("creating {}", path.display()))?;
        let mut writer = std::io::BufWriter::new(file);
        minocrab_zkir::v3::write_zkir(&ours, &mut writer, name)
            .with_context(|| format!("writing {}", path.display()))?;
        writer
            .flush()
            .with_context(|| format!("writing {}", path.display()))?;
    }

    // Keygen for every `.zkir` in the directory; it writes each `.bzkir`
    // beside its `.zkir` as it loads it.
    let status = Command::new(zkir_v3)
        .arg("compile-many")
        .arg(&zkir_dir)
        .arg(&key_dir)
        .status()
        .with_context(|| format!("running {}", zkir_v3.display()))?;
    ensure!(
        status.success(),
        "`{} compile-many` exited {status}",
        zkir_v3.display()
    );

    let artifacts = artifact_files();
    let lines = artifacts
        .iter()
        .map(|file| {
            Ok(format!(
                "{}  {file}",
                sha256_hex(&read(&managed.join(file))?)
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let generated = lines.join("\n") + "\n";
    match mode {
        LockMode::Update => std::fs::write(lock, &generated)
            .with_context(|| format!("writing {}", lock.display()))?,
        LockMode::Verify => {
            let locked = std::fs::read_to_string(lock)
                .with_context(|| format!("reading {}", lock.display()))?;
            if locked != generated {
                // Without keys the package's build refuses to run, so the
                // unlocked bundle cannot be packed.
                std::fs::remove_dir_all(&key_dir)
                    .with_context(|| format!("removing {}", key_dir.display()))?;
            }
            ensure!(
                locked == generated,
                "the generated artifacts differ from {}:\n--- locked\n{locked}--- generated\n{generated}\
                 A change to the circuits, minocrab or zkir-v3 changes the verifier keys and needs a \
                 new deployment; if that is intended, rerun with --update-lock",
                lock.display()
            );
        }
    }

    manifest.zkir = Directory::of(managed, "zkir", &artifacts)?;
    manifest.keys = Some(Directory::of(managed, "keys", &artifacts)?);
    let text = serde_json::to_string_pretty(&manifest)? + "\n";
    std::fs::write(&manifest_path, text)
        .with_context(|| format!("writing {}", manifest_path.display()))
}

/// The bundle's generated artifacts, as paths relative to the managed
/// directory.
fn artifact_files() -> Vec<String> {
    let mut files = Vec::new();
    for (name, _) in CIRCUITS {
        files.push(format!("zkir/{name}.zkir"));
        files.push(format!("zkir/{name}.bzkir"));
        files.push(format!("keys/{name}.prover"));
        files.push(format!("keys/{name}.verifier"));
    }
    files
}

/// Compactc's circuits from `managed`, which must be its untouched
/// `--skip-zk` output: a manifest that lists no keys and exactly the
/// responder's `.zkir` files, each unchanged since compactc wrote it. That is
/// what makes them a reference: a bundle this crate already built fails here.
///
/// # Errors
/// If `managed` is anything other than that output.
pub fn compactc_circuits(managed: &Path) -> anyhow::Result<Vec<(&'static str, IrSource)>> {
    let not_fresh = || {
        format!(
            "{} is not fresh `compact compile --skip-zk` output: run `yarn compile` first",
            managed.display()
        )
    };
    let manifest = read_manifest(&managed.join(MANIFEST)).with_context(not_fresh)?;
    ensure!(
        manifest.keys.is_none(),
        "{}: its manifest already lists keys",
        not_fresh()
    );
    let listed: Vec<&String> = manifest.zkir.files.keys().collect();
    let mut expected: Vec<String> = CIRCUITS
        .iter()
        .map(|(name, _)| format!("{name}.zkir"))
        .collect();
    expected.sort();
    ensure!(
        listed == expected.iter().collect::<Vec<_>>(),
        "{}: its manifest lists zkir {listed:?}, expected {expected:?}",
        not_fresh()
    );
    let mut circuits = Vec::new();
    for (name, _) in CIRCUITS {
        let file = format!("{name}.zkir");
        let path = managed.join("zkir").join(&file);
        let bytes = read(&path)?;
        let entry = &manifest.zkir.files[&file];
        if entry.hash != sha256_hex(&bytes) || entry.size != bytes.len() as u64 {
            bail!(
                "{}: zkir/{file} differs from its manifest entry",
                not_fresh()
            );
        }
        let ir = minocrab_zkir::v3::read_zkir(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        circuits.push((name, ir));
    }
    Ok(circuits)
}

fn read_manifest(path: &Path) -> anyhow::Result<Manifest> {
    let text = read(path).and_then(|bytes| Ok(String::from_utf8(bytes)?))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

fn read(path: &Path) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).with_context(|| format!("reading {}", path.display()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
