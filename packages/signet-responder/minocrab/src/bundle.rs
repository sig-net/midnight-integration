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
use std::fmt::Write as _;
use std::path::Path;
use std::process::Command;

use anyhow::{Context as _, bail, ensure};
use midnight_zkir_v3::IrSource;
use minocrab_publisher::call::hex;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::circuits::COMPACT_CIRCUITS;
use crate::parity::{check_parity, preimage, sample_call};

const MANIFEST: &str = "compiler/contract-manifest.json";

/// `compiler/contract-manifest.json`, field for field in compactc's order.
/// An unknown field, here or in a file entry, fails the parse rather than
/// being dropped on rewrite.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Manifest {
    manifest_version: String,
    compiler_version: String,
    compiler_commit: String,
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

/// One file's listing: `"type": "file"`, its size and its sha-256.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    r#type: String,
    size: u64,
    hash: String,
}

/// What to do with the lock file of artifact hashes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockMode {
    /// Fail if the generated artifacts differ from the lock.
    Verify,
    /// Rewrite the lock from the generated artifacts.
    Update,
}

fn read(path: &Path) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).with_context(|| format!("reading {}", path.display()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn read_manifest(path: &Path) -> anyhow::Result<Manifest> {
    serde_json::from_slice(&read(path)?).with_context(|| format!("parsing {}", path.display()))
}

/// [`compactc_circuits`], with the manifest they were checked against.
fn read_reference(managed: &Path) -> anyhow::Result<(Manifest, Vec<(&'static str, IrSource)>)> {
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
    let mut expected: Vec<String> = COMPACT_CIRCUITS
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
    for (name, _) in COMPACT_CIRCUITS {
        let file = format!("{name}.zkir");
        let bytes = read(&managed.join("zkir").join(&file))?;
        let entry = &manifest.zkir.files[&file];
        if entry.hash != sha256_hex(&bytes) || entry.size != bytes.len() as u64 {
            bail!(
                "{}: zkir/{file} differs from its manifest entry",
                not_fresh()
            );
        }
        // Parsed from the bytes just hashed, so the reference is exactly
        // what compactc's manifest vouches for.
        let ir = minocrab_zkir::v3::parse_zkir(bytes.as_slice(), &file)
            .with_context(|| format!("parsing zkir/{file}"))?;
        circuits.push((name, ir));
    }
    Ok((manifest, circuits))
}

/// Compactc's circuits from `managed`, in [`COMPACT_CIRCUITS`] order, which
/// must be its untouched `--skip-zk` output: a manifest that lists no keys
/// and exactly the responder's `.zkir` files, each unchanged since compactc
/// wrote it. That is what makes them a reference: a bundle this crate already
/// built fails here.
///
/// # Errors
/// If `managed` is anything other than that output.
pub fn compactc_circuits(managed: &Path) -> anyhow::Result<Vec<(&'static str, IrSource)>> {
    Ok(read_reference(managed)?.1)
}

/// The bundle's generated artifacts, as paths relative to the managed
/// directory.
fn artifact_files() -> Vec<String> {
    let mut files = Vec::new();
    for (name, _) in COMPACT_CIRCUITS {
        files.push(format!("zkir/{name}.zkir"));
        files.push(format!("zkir/{name}.bzkir"));
        files.push(format!("keys/{name}.prover"));
        files.push(format!("keys/{name}.verifier"));
    }
    files
}

impl Directory {
    /// The manifest listing of the `files` under `dir/`, read from `managed`.
    fn listing(managed: &Path, dir: &str, files: &[String]) -> anyhow::Result<Directory> {
        let prefix = format!("{dir}/");
        let mut entries = BTreeMap::new();
        for (name, file) in files
            .iter()
            .filter_map(|file| Some((file.strip_prefix(&prefix)?, file)))
        {
            let bytes = read(&managed.join(file))?;
            let entry = Entry {
                r#type: "file".into(),
                size: bytes.len() as u64,
                hash: sha256_hex(&bytes),
            };
            entries.insert(name.to_string(), entry);
        }
        Ok(Directory {
            r#type: "directory".into(),
            files: entries,
        })
    }
}

/// Generates the keys, checks or updates `lock`, and rewrites the manifest.
fn write_keys(
    managed: &Path,
    zkir_v3: &Path,
    lock: &Path,
    mode: LockMode,
    mut manifest: Manifest,
) -> anyhow::Result<()> {
    // Keygen for every `.zkir` in the directory; it writes each `.bzkir`
    // beside its `.zkir` as it loads it.
    let status = Command::new(zkir_v3)
        .arg("compile-many")
        .arg(managed.join("zkir"))
        .arg(managed.join("keys"))
        .status()
        .with_context(|| format!("running {}", zkir_v3.display()))?;
    ensure!(
        status.success(),
        "`{} compile-many` exited {status}",
        zkir_v3.display()
    );

    let artifacts = artifact_files();
    let mut generated = String::new();
    for file in &artifacts {
        let hash = sha256_hex(&read(&managed.join(file))?);
        writeln!(generated, "{hash}  {file}")?;
    }
    match mode {
        LockMode::Update => std::fs::write(lock, &generated)
            .with_context(|| format!("writing {}", lock.display()))?,
        LockMode::Verify => {
            let locked = std::fs::read_to_string(lock)
                .with_context(|| format!("reading {}", lock.display()))?;
            ensure!(
                locked == generated,
                "the generated artifacts differ from {}:\n--- locked\n{locked}--- generated\n{generated}\
                 A change to the circuits, minocrab or zkir-v3 changes the verifier keys and needs a \
                 new deployment; if that is intended, rerun with --update-lock",
                lock.display()
            );
        }
    }

    manifest.zkir = Directory::listing(managed, "zkir", &artifacts)?;
    manifest.keys = Some(Directory::listing(managed, "keys", &artifacts)?);
    let manifest_path = managed.join(MANIFEST);
    let text = serde_json::to_string_pretty(&manifest)? + "\n";
    std::fs::write(&manifest_path, text)
        .with_context(|| format!("writing {}", manifest_path.display()))
}

/// Builds the bundle in `managed`, which must hold fresh
/// `compact compile --skip-zk` output of `signet-responder.compact`.
///
/// Every circuit must first pass [`check_parity`] against compactc's `.zkir`
/// of it; nothing is written until all have. Then our `.zkir` replaces
/// compactc's, `zkir-v3 compile-many` writes the `.bzkir` and the keys, the
/// artifacts are checked against (or written to) `lock`, and the manifest is
/// rewritten.
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
    let (manifest, references) = read_reference(managed)?;
    let mut ours = Vec::new();
    for ((name, build), (_, reference)) in COMPACT_CIRCUITS.iter().zip(&references) {
        let ir = build().ir;
        check_parity(&ir, reference, &preimage(name, &sample_call(name)?)?)
            .with_context(|| format!("{name} fails parity with compactc's circuit"))?;
        ours.push((name, ir));
    }
    for (name, ir) in &ours {
        let path = managed.join("zkir").join(format!("{name}.zkir"));
        let text =
            minocrab_zkir::v3::to_zkir_string(ir).with_context(|| format!("serializing {name}"))?;
        std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    }

    // Without keys the package's build refuses to run, so a bundle that
    // failed anywhere from keygen on cannot be packed: zkir-v3 creates each
    // key file before it runs that circuit's keygen.
    let Err(error) = write_keys(managed, zkir_v3, lock, mode, manifest) else {
        return Ok(());
    };
    let key_dir = managed.join("keys");
    if key_dir.exists()
        && let Err(removal) = std::fs::remove_dir_all(&key_dir)
    {
        return Err(error.context(format!(
            "and removing {} failed, so remove it before building: {removal}",
            key_dir.display()
        )));
    }
    Err(error)
}
