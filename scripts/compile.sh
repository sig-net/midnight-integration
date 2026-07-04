#!/bin/sh
# Dispatch `npm run compile [pkg]` / `npm run compile:zk [pkg]` from the repo root.
# With a package short-name (e.g. vault-contract) it compiles just that workspace;
# without one it compiles every workspace that has a compile script.
set -e
suffix=""
if [ "$1" = "--zk" ]; then suffix=":zk"; shift; fi
if [ -n "$1" ]; then
  exec npm run "compile$suffix" -w "@midnight-erc20-vault/$1"
fi
exec npm run "compile$suffix" --workspaces --if-present
