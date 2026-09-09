#!/bin/sh
# Guards the --feature-zkir-v3 invariant, which nothing else can catch.
#
# The flag does two separable jobs. It makes the secp256k1 types
# (Secp256k1Point, Secp256k1Scalar) exist at all, so a package that reaches
# the ECDSA circuits fails loudly without it. And it selects ZKIR version 3
# over the compiler's default of version 2 — that failure is SILENT: the
# emitted TypeScript is byte-identical, so compile, lint, build and the whole
# unit suite pass while the proving artifacts and verifier keys diverge from
# the deployed contracts. Only a deploy or a proof would reveal it.
#
# Two independent checks, because either alone can be blinded: the output
# check misses packages that emit no zkir, and a change to where compiled
# output lands would hide files from it; the source check is path-independent
# but cannot prove what the compiler actually did.
set -eu

status=0

# 1. Source: every Compact compile invocation passes the flag.
scripts_seen=0
for manifest in packages/*/package.json; do
  # An unmatched glob is passed through literally by the shell, so skip it
  # rather than handing a non-existent path to node.
  [ -f "$manifest" ] || continue
  # One "<name>\t<command>" line per compile* script that shells out to compactc.
  entries=$(
    node -e '
      const fs = require("fs");
      const scripts = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).scripts ?? {};
      for (const [name, cmd] of Object.entries(scripts)) {
        if (name.startsWith("compile") && cmd.includes("compact compile")) {
          console.log(`${name}\t${cmd}`);
        }
      }
    ' "$manifest"
  )
  [ -n "$entries" ] || continue
  while IFS="$(printf '\t')" read -r name cmd; do
    [ -n "$name" ] || continue
    scripts_seen=$((scripts_seen + 1))
    case "$cmd" in
      *--feature-zkir-v3*) ;;
      *)
        echo "check-zkir: $manifest [$name] omits --feature-zkir-v3" >&2
        status=1
        ;;
    esac
  done <<EOF
$entries
EOF
done

if [ "$scripts_seen" -eq 0 ]; then
  echo "check-zkir: found no 'compact compile' scripts to check — the guard is blind, fix its search" >&2
  exit 1
fi

# 2. Output: every emitted zkir declares version 3.
zkir_files=$(find packages -name '*.zkir' -not -path '*/node_modules/*' -not -path '*/dist/*')

if [ -z "$zkir_files" ]; then
  echo "check-zkir: found no .zkir files — run 'yarn compile' first, or the guard is blind" >&2
  exit 1
fi

zkir_seen=0
for f in $zkir_files; do
  zkir_seen=$((zkir_seen + 1))
  if ! grep -q '"major":[[:space:]]*3' "$f"; then
    echo "check-zkir: $f is not ZKIR v3 (compiled without --feature-zkir-v3)" >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "check-zkir: OK — $scripts_seen compile scripts pass --feature-zkir-v3, $zkir_seen zkir files are v3"
fi
exit "$status"
