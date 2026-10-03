#!/usr/bin/env bash
set -euo pipefail
base="$1"
head="$2"
if [[ "$base" =~ ^0+$ ]]; then
  base="$(git hash-object -w -t tree /dev/null)"
fi
paths=(packages/midnight-serde-conformance packages/midnight-serde-ts packages/midnight-serde-rs)
for path in "${paths[@]}"; do
  test -n "$(git ls-tree -r --name-only "$head" -- "$path")"
done
if git diff --quiet "$base" "$head" -- "${paths[@]}"; then
  echo 'changed=false'
else
  status=$?
  test "$status" -eq 1
  echo 'changed=true'
fi
