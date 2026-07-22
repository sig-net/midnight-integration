# Integration Tests — the generic signet-caller e2e

Everything that needs a **running stack** lives here — nowhere else in the
repo touches a network from tests. The pipeline has two halves:

- **Setup** (`src/setup/`, run by vitest **globalSetup** — see
  `vitest.config.ts`): environment preflight → MPC key derivation → the
  deployer dust preflight → zk-compile + deploy the signet contract →
  persist the fakenet hand-off values to `.env` (append-only) + start the
  responder container → zk-compile + deploy the caller contract. Runs ONCE
  in vitest's main process before ANY test file, including single-file runs.
  Every step skips itself when its env var is already set (the hand-off
  steps: when the values are already in `.env` / the responder already runs
  with them). The pipeline is deliberately **EVM-free**: the caller's
  request exists to be SIGNED, never broadcast, so no EVM chain, token, or
  funded derived accounts are involved.
- **The flow file** (`tests/signet-caller-e2e.test.ts`, `--bail 1`): one
  ordered pipeline whose tests run in source order and feed each other
  through module-scoped state —
  1. `initialise` — pin the caller's MPC response key on-chain. The key is
     derived from the caller contract's OWN address (the sender-scoped
     derivation the MPC uses for respond-bidirectional signing), so it only
     exists after the deploy and cannot be a constructor argument: the
     contract pins its hash via this one-shot circuit instead. Idempotent
     across reruns.
  2. `submitSignatureRequest` — drive the caller contract's request circuit
     (contract-fixed minimal calldata) and read the request back MPC-style
     from the raw ledger.
  3. Golden notification — the submit registered a decodable
     `SignBidirectionalNotification` in the signet contract's registry, read
     by field position through the hand-composed descriptors, exactly as the
     MPC reads it.
  4. `pollSignatureResponse` — the fakenet's ECDSA response arrives on the
     signet contract and verifies against the caller's epsilon-derived
     account.
  5. `verifyResponse` — verify an ECDSA respond-bidirectional response
     in-circuit and consume the request. The fakenet only responds after
     observing a broadcast on the destination chain (a leg this generic
     exercise deliberately omits), so the response is signed in-test with
     the MPC response key derived from the suite's shared `MPC_ROOT_KEY`
     and the caller contract address (the same derivation the fakenet uses).

The unit tests beside it (`tests/env-file.test.ts`, `tests/mpc-keys.test.ts`)
run offline under plain `yarn test`; the flow file gates itself with
`describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)`.

## Prerequisites

- **Local dev stack**: `docker compose up -d` at the repo root — Midnight
  (node :9944, indexer :8088, proof server :6300) plus the `evm` service
  (anvil, :8545). The tests never touch the EVM chain; the service exists
  because the fakenet responder's config requires a reachable EVM endpoint
  to boot (`FAKENET_EVM_RPC_URL`, defaulting to the in-network
  `http://evm:8545`).
- **compact compiler** on PATH, then `yarn install` + `yarn compile` from
  the root.
- For the signature-response leg: the fakenet MPC responder — the `fakenet`
  compose service (`ghcr.io/sig-net/fakenet:latest`, built from
  [sig-net/solana-signet-program](https://github.com/sig-net/solana-signet-program)).
  **The setup starts it for you**: right after deploying the signet contract
  it appends `MPC_ROOT_KEY` + `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` to `.env`
  (append-only — existing lines are never touched; a conflicting value is a
  hard error, never an overwrite) and runs the compose command below —
  `--force-recreate` only when the values newly landed in `.env`, plain
  `up -d` (a no-op on a running responder) otherwise. Set `FAKENET_MANAGED=0`
  to manage the responder yourself (e.g. responder development via
  `yarn response` in a solana-signet-program checkout). Manual commands:

  ```sh
  docker compose --profile fakenet up -d --force-recreate fakenet
  docker logs -f fakenet-responder     # responder log
  docker compose pull fakenet          # refresh :latest after a fakenet-v* release
  ```

  The container's config interpolates from the same repo-root `.env`
  (`MIDNIGHT_*`, `MPC_ROOT_KEY`, … with in-network defaults when unset), so
  pointing the stack at another environment is a `.env` change.

## Running

```sh
yarn test:integration-tests                        # from the repo root
yarn test:integration-tests:signet-caller-e2e      # just the caller flow file
```

Either way the globalSetup pipeline runs first — setup is never skipped by
narrowing the selection.

### Wallets: one root funds three roles

The suite runs from a single funded wallet. One **root** wallet holds the
funds and pays out to three **role** wallets — `deployer` (deploys the
contracts), `invoker` (drives the caller circuits) and `mpc responder` (the
fakenet responder's fee-paying wallet). Root itself does no test work.

Each wallet's seed is read from `.env` when present, otherwise generated and
persisted there (append-only), and every wallet's addresses are printed. So
reruns reuse the same wallets; deleting a seed line regenerates that wallet.

- **undeployed:** root defaults to the genesis mint wallet, so the roles are
  funded from genesis at runtime — a fresh run is fully automatic.
- **deployed (e.g. stagenet):** root is generated on the first run, which then
  **STOPS at the root preflight** and prints root's NIGHT address. Fund it via
  the faucet, then rerun: root funds the three roles and the suite proceeds.

### Against a deployed network (e.g. stagenet)

1. `NETWORK_ID=stagenet`, plus the network's endpoints — they are not
   published in this repo, so set `MIDNIGHT_NODE_URL` and
   `MIDNIGHT_NODE_INDEXER_URL` (the WS twin derives from it) in `.env`. The
   proof server stays local, so keep one running at
   `MIDNIGHT_NODE_PROOF_SERVER_URL`, default `http://127.0.0.1:6300`.
2. First run: the setup generates root + the three role seeds into `.env`,
   then stops printing root's NIGHT address. Fund it at the network's faucet
   (set `MIDNIGHT_FAUCET_URL` to have the stop message name it).
3. Rerun: root funds the roles (evenly split, or `FUND_CHILD_NIGHT` each) and
   the pipeline runs to the end. The fakenet responder needs its container
   endpoints pointed at stagenet too (the `MIDNIGHT_*` compose vars).

Every other setup step (MPC keys, compile/deploy, fakenet hand-off) behaves
exactly as on the local stack, and the same `.env`-skip rules apply: set a
contract address to skip its compile+deploy.

Every setup step is **skippable via `.env`**: when its variable is set, the
step verifies it and logs `SKIPPED`, so a populated `.env` goes straight to
the contract calls (~2 min total). Unset, the step does the work, prints
the value to save — and for the fakenet hand-off pair
(`MPC_ROOT_KEY` + `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`) **appends it to
`.env` itself and starts the responder container**, so nothing blocks on a
human between deploy and the flow. A fresh deployment is ONE run:
globalSetup zk-compiles both contracts (~10+ min: background it), deploys
them, hands off to the responder mid-setup, and the flow file runs to the
end (4/4).

**Redeploying after a circuit change?** Comment out the contract-address
vars in `.env` (`MIDNIGHT_SIGNET_CONTRACT_ADDRESS`,
`MIDNIGHT_CALLER_CONTRACT_ADDRESS`) and rerun — see the runbook in
[`../../.claude/skills/e2e/SKILL.md`](../../.claude/skills/e2e/SKILL.md).

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `RUN_INTEGRATION_TESTS` | Opt-in gate (real env only, not `.env`); `test:integration-tests` sets it | unset (flow file skips) |
| `NETWORK_ID`, `MIDNIGHT_NODE_*` | Midnight endpoints (deploy-package config); `undeployed` \| `preview` \| `preprod` \| `stagenet` \| `mainnet` | `undeployed` (local stack) |
| `ROOT_SEED` | Funds the role wallets; does no test work. Faucet-funded on a deployed network | genesis seed `00…01` (undeployed); generated (deployed) |
| `DEPLOYER_SEED`, `INVOKER_SEED`, `MPC_RESPONDER_SEED` | The role wallets (deploy / invoke / fakenet responder); generated + persisted to `.env` and funded from root, or set to reuse | generated per run |
| `FUND_CHILD_NIGHT` | NIGHT (base units) to move from root into each role wallet that needs funding | unset (split root's balance evenly) |
| `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`, `MIDNIGHT_CALLER_CONTRACT_ADDRESS` | Deployed contracts; set to skip compile+deploy | deployed by setup (signet appended to `.env` automatically; caller printed — save it to skip redeploys) |
| `MPC_ROOT_KEY` | Fakenet signer root key | derived by setup, appended to `.env` |
| `MPC_SECP256K1_PUBKEY` | MPC root public key | derived from root key |
| `MPC_RESPONSE_KEY` | The MPC respond-bidirectional key for the caller contract (pinned on-chain by the flow's initialise leg) | derived from root key + caller contract address |
| `FAKENET_MANAGED` | `0` = setup neither writes the hand-off values to `.env` nor touches the responder container — you run the responder yourself (responder development) | unset (setup manages the responder) |
| `FAKENET_EVM_RPC_URL` | EVM endpoint as reachable from the fakenet CONTAINER (compose-only; not read by the tests) | `http://evm:8545` |
| `TRUST_PREBUILT_ZK_KEYS` | `1` = setup skips `compile:*:zk` when prover keys are already present. CI-only: the CI cache is keyed on the contract sources, so present ⇒ fresh; locally stale keys would poison deploys — never set it by hand | unset |
| `CALLER_REQUEST_ID` | Resume an in-flight request, skipping the (heavy) submit prove | unset |
| `STEP_THROUGH` | `1` pauses before each setup step and each test (hit enter) — interactive debugging only, never unattended | unset |

## Gotchas

- The signature-poll test timing out while everything else passes means the
  MPC responder is down or watching a stale signet contract address —
  `docker logs fakenet-responder`.
- Proof failures surface as `Failed Proof Server response … 400`; the real
  error is in `docker logs midnight-proof-server`.
- midnight-js persists private state in `midnight-level-db/` keyed by seed;
  `rm -rf midnight-level-db` resets it.
- In the `test:integration` script, `--bail 1` must stay LAST: the
  file-scoped script appends its `tests/<name>.test.ts` filter after it,
  and a trailing BOOLEAN flag (`--disable-console-intercept`) would swallow
  that filter as its value — vitest then silently runs EVERY test file.
