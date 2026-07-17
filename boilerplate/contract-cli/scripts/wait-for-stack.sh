#!/usr/bin/env bash
# Block until the standalone stack (node + indexer + proof-server) is serving, so the
# integration tests don't race startup. Endpoints match StandaloneConfig in src/config.ts.
set -euo pipefail

wait_for() {
  local name="$1" url="$2" tries="${3:-120}"
  echo "==> waiting for $name ($url)"
  for ((i = 1; i <= tries; i++)); do
    if curl -sf -o /dev/null "$url"; then
      echo "    $name is up (${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "    $name did not come up within ${tries}s" >&2
  return 1
}

wait_for "node"         "http://127.0.0.1:9944/health"
wait_for "proof-server" "http://127.0.0.1:6300"

# The indexer answers GraphQL over POST; a reachable TCP listener returning any HTTP
# response (even an error body) is enough to know it's serving.
echo "==> waiting for indexer (http://127.0.0.1:8088)"
for ((i = 1; i <= 120; i++)); do
  if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8088/api/v3/graphql | grep -qE '^[0-9]{3}$'; then
    echo "    indexer is up (${i}s)"
    break
  fi
  sleep 1
  if [[ $i -eq 120 ]]; then echo "    indexer did not come up within 120s" >&2; exit 1; fi
done

echo "==> standalone stack ready"
