# secp256k1 ECDSA on Midnight — progress & readiness for in-circuit MPC signature verification

**Date:** 2026-07-09
**Question:** Do the Midnight libraries in use support secp256k1 ECDSA yet? Can a Compact
contract verify the signatures our MPC produces for foreign-chain integrations, in-circuit?

**Short answer:** The **curve primitives are landing** (runtime has them; the compiler exposes
types + point ops behind a feature flag), but they are **RC-grade, incomplete, and not in a
public release**. The **high-level `verifyEcdsaSecp256k1` primitive we actually need is
unscheduled**. Separately — and importantly — the ECDSA/curve work the team is *actively*
shipping is for **P256 and ed25519** (governance / maintenance-committee signing), **not
secp256k1** (our external-chain / MPC curve). Keep the existing "unverifiable in-circuit /
unauthenticated append-only log" design in place for now.

---

## 1. What the MPC actually produces (confirmed)

Traced in `~/Projects/github.com/sig-net/mpc`.

- **Scheme:** threshold **ECDSA over secp256k1** via **cait-sith**, for *every* foreign-chain
  integration (Ethereum, Bitcoin, Cosmos, Solana, Canton, Hydration, NEAR). There is only one
  signature scheme.
  - `chain-signatures/node/src/types.rs:20-21` — protocol output is
    `PresignOutput<Secp256k1>` → `FullSignature<Secp256k1>`.
  - Deps: `cait-sith` + `k256` + `ecdsa 0.16.9` across every `chain-*` crate.
- **Signature shape** (`chain-signatures/primitives/src/crypto.rs:126-137`):
  ```rust
  struct Signature { big_r: AffinePoint, s: Scalar, recovery_id: u8 }
  ```
  Standard ECDSA `(r, s)` where `r = x_coordinate(big_r)` reduced into the scalar field
  (`crypto/src/kdf.rs:163`), plus a recovery id.
- **Key derivation** (`crypto/src/kdf.rs:154`): additive tweak on secp256k1 —
  `derived_pk = G·epsilon + root_pk`. Per-chain/per-user derived keys are also secp256k1 points.
- **Verification** (`check_ec_signature`, `crypto/src/kdf.rs:171`): reconstructs
  `k256::ecdsa::Signature::from_scalars(r, s)` and does `ecrecover` against the derived pubkey —
  textbook secp256k1 ECDSA over a **pre-hashed** message (`payload: Scalar`, a 32-byte digest
  reduced into the scalar field).

**Verification math** (given pubkey `Q`, prehash `z`, sig `(r, s)`):
```
w  = s⁻¹ mod n
R' = (z·w)·G + (r·w)·Q      accept iff  x(R') mod n == r
```
Every step maps onto secp256k1 base-field + scalar-field arithmetic and point ops — exactly the
primitives Midnight is adding. `Q` can even be re-derived in-circuit from the sealed root key +
epsilon (`G·ε + root_pk`), so an in-circuit verifier would not have to trust an off-chain `Q`.

---

## 2. Runtime support — PRESENT ✅

`@midnight-ntwrk/compact-runtime@0.18.0-rc.0` (the version pinned in
`midnight-erc20-vault-refactor`) ships the full secp256k1 foreign-curve primitive set.

From `node_modules/@midnight-ntwrk/compact-runtime/dist/built-ins.d.ts` / `constants.js`:

- **Types:** `Secp256k1Point`, `Secp256k1Base` (base field), `Secp256k1Scalar` (scalar field),
  with runtime `CompactType` descriptors.
- **Base field:** `secp256k1BaseAdd/Neg/Mul/Inv`
- **Scalar field:** `secp256k1ScalarAdd/Neg/Mul/Inv`
- **Point ops:** `secp256k1Add`, `secp256k1Mul`, `secp256k1MulGenerator`, `secp256k1PointX`,
  `secp256k1PointY`
- **Constants:** `SECP256K1_BASE_MODULUS`, `SECP256K1_SCALAR_MODULUS` (+ MAX values), backed by
  `@noble/curves/secp256k1`.

This is sufficient (at the runtime/proving level) to express ECDSA verification. There is **no
turnkey `ecdsaVerify` builtin** — the runtime gives building blocks, not a verifier.

---

## 3. Compiler support — PARTIAL, GATED, and BUGGY ⚠️

**Toolchain:** `compactc 0.33.0` (installed as `0.33.0-rc.0`; max language version **0.25.0**).
Verified empirically by compiling test circuits against
`~/.compact/versions/0.33.0-rc.0/aarch64-darwin/compactc`.

### 3a. Gated behind `--feature-zkir-v3`

The default ZK backend rejects secp256k1 outright:

```
secp256k1 is not supported in ZKIR v2: try recompiling with the flag `--feature-zkir-v3`
```

`Secp256k1Point/Scalar/Base` only bind once `--feature-zkir-v3` is passed (there is a separate
`zkir-v3` binary in the toolchain). **The repo's own compile scripts use default ZKIR (v2)** —
none pass `--feature-zkir-v3` — so switching to secp256k1 would mean moving the whole toolchain
to zkir-v3.

### 3b. What compiles (with the flag)

| Construct | Language form | Status |
|---|---|---|
| Types | `Secp256k1Point` / `Secp256k1Scalar` / `Secp256k1Base` | ✅ bind |
| Point add | `ecAdd(p1, p2)` — **overloaded**, not `secp256k1Add` | ✅ |
| Scalar·point | `ecMul(q, u)` | ✅ |
| Generator·scalar | `ecMulGenerator(u)` | ✅ |
| x-coordinate | `secp256k1PointX(p) → Secp256k1Base` | ✅ |
| Scalar field multiply | native `*` operator | ✅ |
| Scalar equality | native `==` | ✅ |

Note: the callable builtins are the **overloaded `ec*` names** (same identifiers as JubJub,
dispatched by argument type). The runtime's `secp256k1Mul` / `secp256k1MulGenerator` /
`secp256k1ScalarInv` names are **not** bound in the language.

### 3c. What breaks — blocker for a real ECDSA verifier

Two constructs a real verifier needs both trigger an **internal compiler error**
(`Internal error (please report): nanopass-case: empty else clause hit` — the cast analysis pass
only handles `curve-jubjub`, not secp256k1):

- **Constructing a scalar constant:** `1 as Secp256k1Scalar` → 💥 internal error
- **Cross-field cast:** `r as Secp256k1Base` (needed to compare the recovered x-coordinate to `r`)
  → 💥 internal error

Also, `Secp256k1Scalar` supports only `*` and `==` — **not** `+`, `-`, or `/` (Compact has no
division operator at all). So `s⁻¹` must be done as a witnessed-inverse constraint `s * w == 1`,
which itself needs the `1` constant that crashes the compiler.

**Net:** you can express point arithmetic and scalar multiplication, but you **cannot currently
compile a complete secp256k1 ECDSA-verify circuit** — you stall on the field-cast compiler bug.
This is genuinely RC-grade, matching the repo's own long-standing assessment
("compactc 0.33 / runtime 0.18 are RC-grade").

---

## 4. Upstream roadmap & timeline (GitHub)

### 4a. The compiler moved to the Linux Foundation

Active development is now at **`LFDT-Minokawa/compact`** (Midnight's LFDT project codename
*Minokawa*), not `midnightntwrk/compact`. Public `midnightntwrk/compact` releases stop at
**0.31.1 (language 0.23.0)** — **0.33.0-rc.0 is unreleased**. None of the secp256k1 work is in a
shipped compiler yet.

### 4b. The active ECDSA/curve work is P256 + ed25519 — NOT secp256k1

The signature-verification primitives being *actively built* are for different curves than the
MPC uses:

| Issue | Curve / primitive | Status |
|---|---|---|
| [LFDT compact #532](https://github.com/LFDT-Minokawa/compact/issues/532) | **P256** curve ops | open, being worked |
| [LFDT compact #535](https://github.com/LFDT-Minokawa/compact/issues/535) | `verify_ecdsa_p256` (**P256**) | open, blocked by #532 |
| [LFDT compact #533](https://github.com/LFDT-Minokawa/compact/issues/533) | Curve25519 ops | open |
| [LFDT compact #534](https://github.com/LFDT-Minokawa/compact/issues/534) | `verify_ed25519` | open |

Backed by real cross-repo work: [midnight-ledger #603](https://github.com/midnightntwrk/midnight-ledger/issues/603)
(P256 ZKIR ops), [midnight-ledger #604](https://github.com/midnightntwrk/midnight-ledger/issues/604)
(Curve25519 ZKIR ops), and the `zkir-v2 → zkir-v3` migrations in
[midnight-js #994](https://github.com/midnightntwrk/midnight-js/issues/994) /
[midnight-wallet #510](https://github.com/midnightntwrk/midnight-wallet/issues/510)
("for new curve operations").

**Driver:** MIP-0003 "ECDSA Support" and the **contract-maintenance-committee** governance
signing path ([midnight-node #1542](https://github.com/midnightntwrk/midnight-node/issues/1542),
[#1838](https://github.com/midnightntwrk/midnight-node/issues/1838); Ledger-9 maintenance-authority
keys in [midnight-js #1050](https://github.com/midnightntwrk/midnight-js/issues/1050)) — this
path is **P256/ed25519**, not secp256k1.

### 4c. Where secp256k1 specifically stands

**Low-level curve primitives** (the types + `ecMul/ecAdd/ecMulGenerator` confirmed in §3):
- [LFDT compact #104 "Add secp256k1 Point"](https://github.com/LFDT-Minokawa/compact/issues/104)
  — labeled **`release: 0.32`**, `feat: ecdsa`, triaged — but **still OPEN**. Depends on
  [#102](https://github.com/LFDT-Minokawa/compact/issues/102) (ZKIR type annotations, open).
  Design decision in the thread: secp256k1 points are represented as
  `(Secp256k1Base, Secp256k1Base)` (like JubJubPoint), plus `Secp256k1Scalar`.
- ZKIR backend: [midnight-ledger #557 "Support Secp256k1 in ZKIR v3"](https://github.com/midnightntwrk/midnight-ledger/issues/557)
  — **CLOSED** (2026-06-17). ✅

This is consistent with what was observed: types + point ops present in the 0.33-rc backend under
`--feature-zkir-v3`, but the language surface incomplete (field casts crash). #104 being open
explains the gap.

**The ECDSA-verify primitive we need:**
- [LFDT compact #441 "Feature Request: ECDSA signatures over SECP256k1"](https://github.com/LFDT-Minokawa/compact/issues/441)
  proposes exactly:
  ```compact
  export circuit verifyEcdsaSecp256k1(public_key, message_hash, signature): Boolean
  ```
  over a **pre-hashed** message (precisely the MPC model — hashing is the caller's responsibility).
  Status: **OPEN, no milestone, no assignee, no project, no release label, 0 comments** since
  2026-05-14. → **Unscheduled.**

---

## 5. Bottom line

| Layer | State |
|---|---|
| MPC signature scheme | secp256k1 threshold ECDSA `(r, s, recovery_id)`, pre-hashed msg — one scheme, all chains |
| `compact-runtime@0.18.0-rc.0` | ✅ full secp256k1 primitive set |
| `compactc 0.33` language surface | ⚠️ types + point ops behind `--feature-zkir-v3`; field-element casts hit an internal-compiler-error → **cannot compile a full ECDSA verifier today** |
| Public release | ❌ latest public compiler is 0.31.1 (lang 0.23.0); 0.33-rc is unreleased |
| secp256k1 curve ops upstream | 🚧 targeted **release 0.32** (LFDT #104), still open |
| secp256k1 ECDSA verify upstream | ❌ **unscheduled** (LFDT #441, no milestone) |
| Team's active ECDSA investment | ➡️ **P256 + ed25519** (governance / maintenance committee), not secp256k1 |

**Implication for this repo:** in-circuit verification of MPC secp256k1 signatures is **not usable
today** and **not yet scheduled upstream**. Keep the current design — MPC signature responses stay
on the **unauthenticated, append-only log** verified off-chain
(`packages/signet-midnight/src/Signet.compact:256`), and the migrate-to-ECDSA TODO
(`Signet.compact:135`) stays parked. The embedded-curve Schnorr-on-JubJub path remains the only
in-circuit-verifiable attestation.

---

## 6. Things to watch / follow-ups

- **Track [LFDT compact #441](https://github.com/LFDT-Minokawa/compact/issues/441)** — the
  secp256k1 ECDSA verify primitive. This is the gating item for us. Consider commenting with the
  MPC use case (pre-hashed 32-byte digest, `(big_r, s, recovery_id)` shape, additive key
  derivation) to push prioritization.
- **Track [LFDT compact #104](https://github.com/LFDT-Minokawa/compact/issues/104)** (release
  0.32) — completes the secp256k1 curve types + should fix the field-cast compiler bug.
- **Watch for the first public compactc that closes #104** (likely 0.32.x public) — until then
  secp256k1 is RC-only.
- **Do not** switch the repo's compile scripts to `--feature-zkir-v3` for production; it's the
  experimental backend and the secp256k1 path is incomplete.
- Note the ecosystem's ECDSA momentum is P256-first. If any of our attestation needs could be met
  by P256 or ed25519 (they can't for MPC foreign-chain sigs, which are fixed at secp256k1), those
  would land materially sooner.

---

## Appendix: reproduction

Minimal probe that demonstrates the compiler state (run against
`~/.compact/versions/0.33.0-rc.0`, with `COMPACT_PATH` pointing at the refactor repo's
`node_modules`):

```compact
pragma language_version >= 0.25;
import CompactStandardLibrary;

// Compiles with --feature-zkir-v3:
export circuit ok(q: Secp256k1Point, u1: Secp256k1Scalar, u2: Secp256k1Scalar): Secp256k1Base {
  const rp = ecAdd(ecMulGenerator(u1), ecMul(q, u2));
  return secp256k1PointX(rp);
}

// Both of these crash the compiler ("Internal error … empty else clause hit"):
//   const one = 1 as Secp256k1Scalar;        // literal cast into scalar field
//   const x   = someScalar as Secp256k1Base; // cross-field cast
```

Commands used:
```sh
# gate check (fails without the flag):
COMPACT_PATH=<refactor>/node_modules compact compile +0.33.0-rc.0 --skip-zk probe.compact out
# → "secp256k1 is not supported in ZKIR v2: try recompiling with the flag --feature-zkir-v3"

# with flag (point ops OK, casts crash):
COMPACT_PATH=<refactor>/node_modules compact compile +0.33.0-rc.0 --skip-zk --feature-zkir-v3 probe.compact out
```
