#!/usr/bin/env bash
# Run the vault integration suite locally, mirroring .github/workflows/integration-tests.yml
# step for step. Use this to grok what CI does and watch each phase's output.
#
# Prerequisites (installed once, not handled here):
#   - Node 24, Docker (with `docker compose`)
#   - Compact tools:  curl --proto '=https' --tlsv1.2 -LsSf \
#       https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
#     then:           compact update 0.31.0
#
# Usage:  scripts/run-integration-local.sh [vitest-target]
#   default target: src/test/vault.api.test.ts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/boilerplate/contract-cli"
TARGET="${1:-src/test/vault.api.test.ts}"
cd "$ROOT"

phase() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

phase "1/6  Install workspace dependencies (npm install — lockfile is gitignored)"
npm install

phase "2/6  Compile the contract — full ZK, generates ~428MB of proving keys"
compact compile boilerplate/contract/src/erc20-vault.compact boilerplate/contract/src/managed/erc20-vault

phase "3/6  Build the contract workspace (tsc -> dist, copy managed keys -> dist/managed)"
npm run build -w boilerplate/contract

phase "4/6  Build the local-EVM harness (hardhat compile)"
( cd boilerplate/evm && npm install && npx hardhat compile )

phase "5/6  Start the standalone stack (node + indexer + proof-server) and wait for it"
cd "$CLI"
docker compose -f standalone.yml pull
docker compose -f standalone.yml up -d
./scripts/wait-for-stack.sh

cleanup() {
  phase "Teardown  docker compose down -v"
  docker compose -f standalone.yml down -v || true
}
trap cleanup EXIT

phase "6/6  Run the integration suite: $TARGET"
npx vitest run "$TARGET"
