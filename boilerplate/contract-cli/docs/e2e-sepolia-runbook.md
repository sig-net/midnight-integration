# E2E runbook — vault against real Sepolia + fakenet MPC signer

`vault.e2e.test.ts` runs the full cross-chain flow against **real Sepolia** and the
**fakenet MPC signer** (`yarn response` → the `fakenet-signer` workspace) — a
single-key dev signer that holds `MPC_ROOT_KEY` and signs directly, **not** a real
threshold MPC. (The `vault.api.test.ts` suite instead uses an in-process simulator +
local Hardhat.) It covers deposit, claim (+ 4 claim-rejection cases), and withdraw:

- STEP 6 — a withdrawal whose EVM transfer succeeds: after the MPC signs the result, `completeWithdraw` finalizes it (removes the request; on success it mints nothing and needs no identity, so any caller can run it).
- STEP 7 — a withdrawal the EVM rejects (stale nonce → MPC returns `0xdeadbeef`): the withdrawer calls `completeWithdraw`, proving the identity committed at withdraw, and it re-mints their coin (refund) with a fresh random nonce so the coin is unlinkable.
- STEP 8 — after transferring the vault-token balance A→B, the old owner can no longer fund a withdrawal and the new owner can; a successful withdrawal is finalized by any caller (permissionless).

You run three processes: the Midnight stack, the MPC server, and the test.

## The one invariant

`MPC_ROOT_KEY` (MPC server) → the Jubjub + secp public keys (deploy) → the contract's
stored `mpcPubKeyHash`. If the root key the MPC signs with differs from the one the
keys were derived from, every `claim`/`completeWithdraw` fails with
`Unauthorized: wrong public key`. Cross-check: the MPC logs `Jubjub pk hash = …` at
startup — it must match what the deployed contract stored.

## Step 0 — one-time prep

```sh
cd <repo>
npm install
compact update 0.31.0
compact compile boilerplate/contract/src/erc20-vault.compact boilerplate/contract/src/managed/erc20-vault
npm run build -w boilerplate/contract
( cd ../solana-signet-program && yarn install )
```

## Step 1 — pick the MPC root key

```sh
export MPC_ROOT_KEY=0x$(openssl rand -hex 32)
echo $MPC_ROOT_KEY      # both sides MUST use this same value
```

## Step 2 — derive the public keys deploy needs

```sh
cd boilerplate/contract-cli
MPC_ROOT_KEY=$MPC_ROOT_KEY npx tsx src/derive-mpc-keys.ts
```

Prints `MPC_JUBJUB_PK_X`, `MPC_JUBJUB_PK_Y`, `MPC_SECP256K1_PUBKEY`.
(There is no other script for this — `compute-mpc-public-values.ts` was an older
`mpc:auth:` commitment scheme the current contract no longer uses.)

## Step 3 — configure the MPC server

Edit `solana-signet-program/.env` (template in its `.env.example`):

```sh
MPC_ROOT_KEY=0x<same as Step 1>
INFURA_API_KEY=<your infura key>
MIDNIGHT_NODE_URL=http://127.0.0.1:9944
MIDNIGHT_INDEXER_URL=http://127.0.0.1:8088/api/v3/graphql
MIDNIGHT_INDEXER_WS_URL=ws://127.0.0.1:8088/api/v3/graphql/ws
MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:6300
MIDNIGHT_WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
# MIDNIGHT_CONTRACT_ADDRESSES — fill in after Step 5
```

## Step 4 — Terminal A: Midnight stack

```sh
cd boilerplate/contract-cli
docker compose -f standalone.yml up -d && ./scripts/wait-for-stack.sh
```

## Step 5 — deploy the contract

```sh
cd boilerplate/contract-cli
MIDNIGHT_NETWORK=standalone \
MPC_JUBJUB_PK_X=<Step 2> MPC_JUBJUB_PK_Y=<Step 2> MPC_SECP256K1_PUBKEY=<Step 2> \
  npx tsx src/deploy-for-e2e.ts
```

Save the printed **contract address** and **derived Sepolia vault address**.

## Step 6 — fund on Sepolia

Send USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) and ETH for gas to the
derived vault address (and the user address for deposits).

## Step 7 — Terminal B: start the fakenet MPC signer

Set `MIDNIGHT_CONTRACT_ADDRESSES=<contract address>` in `solana-signet-program/.env`, then:

```sh
cd ../solana-signet-program
yarn response          # fakenet-signer; listens on ws://localhost:3030; logs the Jubjub pk hash
```

## Step 8 — Terminal C: run the suite

```sh
cd boilerplate/contract-cli
MIDNIGHT_CONTRACT_ADDRESS=<Step 5> \
MPC_SECP256K1_PUBKEY=<Step 2> \
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/<key> \
MPC_WS_URL=ws://localhost:3030 \
MIDNIGHT_NETWORK=standalone \
MIDNIGHT_WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001 \
MIDNIGHT_WALLET_SEED_B=0000000000000000000000000000000000000000000000000000000000000002 \
  npx vitest run src/test/vault.e2e.test.ts
```

## Env var reference

| Var | Where | Required | Default |
|---|---|---|---|
| `MPC_ROOT_KEY` | MPC server | yes | — |
| `MPC_JUBJUB_PK_X` / `_Y` | deploy | yes | — (Step 2) |
| `MPC_SECP256K1_PUBKEY` | deploy + test | no | baked-in default |
| `MIDNIGHT_CONTRACT_ADDRESS` | test | yes | — (throws) |
| `MIDNIGHT_CONTRACT_ADDRESSES` | MPC server | yes | — |
| `SEPOLIA_RPC_URL` / `INFURA_API_KEY` | test + MPC | yes | Infura via key |
| `MPC_WS_URL` | test | no | `ws://localhost:3030` |
| `MIDNIGHT_WALLET_SEED` | test/deploy/MPC | no | genesis `00…01` |
| `MIDNIGHT_WALLET_SEED_B` | test | STEP 8 only | — |
| `MIDNIGHT_NETWORK` | test/deploy | no | `standalone` |
| `MIDNIGHT_{NODE,INDEXER,INDEXER_WS,PROOF_SERVER}_URL` | MPC server | yes | — |

The Midnight stack itself needs no env — `APP__INFRA__SECRET` is inlined in `standalone.yml`.
