#!/usr/bin/env bash
# The repository's whole offline verification, in CI's order. `yarn verify` runs every part.
#   scripts/verify.sh [skip-zk] [zk] [midnight-serde-rs]
# Lint and build read the generated src/managed/ types, so they follow the compile, and build and
# test need the zk keys, so they follow the keygen.
# CI's unit job runs `skip-zk` and `zk` as two calls, because its zk-key cache restore has to
# land between them: `yarn compile` replaces each package's src/managed/, keys included.
set -euo pipefail
cd "$(dirname "$0")/.."

skip_zk() {
  yarn format:check
  yarn compile
  # Inside the crate, where rustup finds its pinned rust-toolchain.toml.
  (cd packages/signet-responder/minocrab && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings)
  yarn test:signet-responder:minocrab
}

zk() {
  # signet-contract's publish-safety check and the test caller's unit tests need these keys.
  if ls packages/signet-contract/src/managed/keys/*.prover >/dev/null 2>&1; then
    echo "signet-contract prover keys present, skipping keygen"
  else
    yarn compile:signet-contract:zk
  fi
  if ls packages/test-caller-contract/src/managed/test-caller-contract/keys/*.prover >/dev/null 2>&1; then
    echo "test-caller prover keys present, skipping keygen"
  else
    yarn compile:test-caller-contract:zk
  fi
  yarn compile:signet-responder:zk
  yarn lint
  yarn build
  yarn test
}

midnight_serde_rs() {
  (cd packages/midnight-serde-rs && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings)
  yarn test:midnight-serde-rs
}

parts=("$@")
[ ${#parts[@]} -gt 0 ] || parts=(skip-zk zk midnight-serde-rs)
for part in "${parts[@]}"; do
  case "$part" in
    skip-zk) skip_zk ;;
    zk) zk ;;
    midnight-serde-rs) midnight_serde_rs ;;
    *) echo "verify.sh: unknown part '$part' (skip-zk, zk, midnight-serde-rs)" >&2; exit 2 ;;
  esac
done
