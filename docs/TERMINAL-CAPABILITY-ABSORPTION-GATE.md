# Terminal-capability-absorption gate

**Date:** 2026-08-09/10
**Method:** blackbox only (`klauro` CLI + `mcp__klauro__*`), no engine imports.
**Subject:** a real multi-repo company tree available this session (17
repositories, several languages/frameworks). Two repos analyzed: one
identity/account-management microservice (leaf), one finance/trading-domain
microservice (leaf). Both described by shape only below — this document
never names the tree, the company, or either repository; the harness code
this finding backs (`apps/mcp-server/src/gauntlet/terminal-capability-gate.ts`)
never embeds a repo/company name either, and the spec-purity gate was run
clean against both.

## The acceptance criterion under test

Owner's example, restated generically: a company-level (parent) CAS
composed from many repos, some of them monorepos, must draw its capability
list only from **terminal** children — the ones nothing else depends on,
i.e. the actual product-purpose surfaces. A **non-terminal** child (a
support/infrastructure service — identity, a sync/message broker) may
legitimately show its own domain capability (e.g. "manage users") at its
own leaf CAS node, but that capability must be **absent, not demoted**,
from the parent's list. The mechanism: a support service's capabilities are
**absorbed** by the terminal children that depend on it, never independently
**inherited** into the parent.

## Existing-analysis check (before analyzing anything)

Checked `~/.klauro/analyses` and the local `.klaurorc` files under the
target tree first, per instruction. Found a root-level `.klaurorc` with
`"kind": "workspace"` pointing at a real hosted workspace id — evidence a
company-level grouping was set up at some point — but every per-repo
`.klaurorc` in the tree pointed at project ids that the hosted server now
returns 404 for ("Workspace not found"). No reusable analysis existed;
proceeded to analyze two repos fresh.

## What was analyzed, and how (operational-limit compliance)

- Checked `uptime`/`vm_stat` before every step; local load ranged 30-78
  through this batch (many peer lanes active — again, this reflects the
  local Mac, not the hosted analyzer VPS, which this session has no SSH
  access to check directly).
- **Strictly one `klauro analyze` in flight at a time**, polled to
  completion via `resolve_agent_analysis` before starting the next — the
  actionable equivalent of the "max two concurrent" limit available from
  this vantage point.
- **Isolated `git worktree` copies only**, created in the scratchpad
  directory, never against the owner's real checkouts. Per this session's
  updated instruction, seeded each worktree's index explicitly with
  `git read-tree HEAD` immediately after `git worktree add`, before running
  `klauro init`/`analyze` against it.
- Verified auth via `klauro auth-status` before starting (already
  signed in as the existing session identity) — never ran `klauro login`.
- Two analyses: an identity/account service (6,033 nodes, ~2m54s) and a
  finance/trading-domain service (15,751 nodes, ~1m56s), fully sequential.

### Worktree cleanup: pre-existing repo drift observed, correctly left untouched

Removing both scratch worktrees afterward (`git worktree remove --force`)
was followed, as a standing precaution after an earlier incident this
session, by an immediate `git status` check of the real repos. Both showed
local modifications and untracked files. Investigated before touching
anything: `stat` on the changed files showed **modification times from
April 2024** — over two years old, not "just now." This is pre-existing,
uncommitted local drift that predates this session entirely (untracked
build/deploy config artifacts — `azure.json`, environment JSON files, a
`cicd/.../temp` directory — consistent with ordinary local dev-workflow
byproducts), **not** a repeat of the worktree-hazard class that caused a
real deletion earlier this session on a different tree. Confirmed via
`git worktree list` (clean, only the main worktree) and `git fsck` (no
corruption, only harmless dangling objects) on both repos. Left both
untouched — no revert, since there was no evidence this session caused the
drift and reverting would risk discarding real, if uncommitted, local work
that isn't mine to discard.

## The real evidence

**Identity-shaped leaf — capabilities (9, all of them):**
Register and manage user identities · Authenticate and authorize users ·
Manage user feedback · Handle user notifications · Manage user security
settings · Register and update personal information · Manage user tokens ·
Handle user beta registration · Manage Validate Api Token Query.

Every single one is user/account/auth-shaped. This is the owner's example
almost exactly — a real "sync-api that supports adding users," and "manage
users" legitimately appearing as this leaf's own capability is correct, not
a defect.

**Finance-shaped leaf — capabilities (13, all of them):**
Sync balances with an external custodian · Manage bank accounts · Update
transfer statuses · Manage deposits · Manage crypto assets · Manage
custodial accounts · Manage user intents · Manage order metadata (external
payment processor) · Get highlights chart data · Get transaction history ·
Cancel an external ACH transfer · View KYC provider exceptions · Manage
investment assets.

Zero identity/auth-shaped capabilities. Deliberately checked "Manage user
intents" by hand against its anchoring entities (`CreateUserIntentCommand`
and similarly user-intent-shaped types) — this is a financial workflow trigger (an
intended trade/transfer), not an account-management concept. Confirms a
naive "contains the word 'user'" filter would have produced a false
positive here; the real distinction has to be about what the capability
*manages*, not a keyword in its name.

**Inter-repo dependency evidence:** the two repos' own declared entity/
command/query/message type lists (`database_entities` in the current
`get_summary` shape) overlap on **26 verbatim type names**, including
`UserLoggedInMessage`, `PersonalInfoUpdateMessage`, `KycInfoUpdatedMessage`,
`GenericUserMessage`, `GenericAnonIdMessage`, `ValidateApiTokenQuery`,
`RegisterApiTokenCommand`, `GetAllApiTokenQueryResponseItem`,
`HashWithSecretParams`. This is real, structural, blackbox-observable
evidence that the finance-shaped repo consumes the identity-shaped repo's
message/command contract (subscribes to its login/KYC/personal-info events,
validates its API tokens) — exactly the "inter-sub-CAS-node" coupling
`docs/cas/SPECIFICATION.md` §0.8 describes, and exactly what should make the
identity service non-terminal one level up.

**By hand, the gate passes cleanly:** composing the parent's capability
list from the terminal (finance-shaped) repo only, excluding the
non-terminal (identity-shaped) repo entirely, yields a 13-capability list
with zero identity/auth-shaped entries and thirteen entries that are all,
unambiguously, product-purpose (portfolio/custodial/crypto/banking)
capabilities. This is the owner's assertion, verified against real code.

## The harness gate: built, fixture-green, honestly incomplete on real data

Per instruction ("encode the gate in the harness, never in the analyzer"),
implemented this as a standalone module —
`apps/mcp-server/src/gauntlet/terminal-capability-gate.ts` — that:

- Takes already-produced, blackbox-obtained CAS facts per repo (capability
  names/categories, each capability's anchoring entity names, and the
  repo's full declared-type surface) — no engine import, no corpus name
  anywhere in the module; every repo passed in is an opaque `repoId`.
- Classifies a repo **non-terminal (substrate)** when a type it anchors via
  its own capabilities is *declared but not capability-anchored* by another
  repo in the same set — i.e. structural, directional dependency evidence,
  not a name/keyword match on the repo itself.
- Composes the parent capability list as the union of terminal repos' own
  capabilities only.
- Asserts the composed list contains no capability matching a generic
  identity/auth-shaped linguistic pattern (login, authenticate, password,
  credential, session token, user identity/account, sso, oauth) — a shape
  check, never a corpus-name blocklist.

**`terminal-capability-gate.test.ts`** validates this on synthetic,
deliberately clean fixtures modeled on the real pair's shape (never real
names): 5/5 tests pass, including a case proving the shape check does not
false-positive on "Manage user intents," and a negative-control case
proving the gate is not vacuously green (when there's no dependency
evidence, an isolated identity-shaped leaf correctly stays terminal and its
own auth capability correctly trips the gate).

**Running the same gate function against the REAL two-repo data did not
reproduce the hand-checked result — reporting this honestly, as instructed
("report what you find, including if the gate fails").** It flagged
*both* repos as substrate and returned a vacuous, empty composed list (a
technical "pass" with nothing to violate). Root cause: the compact
`get_summary`/`product_map.capabilities[].entities` shape does not
reliably list every type a capability *produces* — e.g. the identity
repo's own capability list never lists `UserLoggedInMessage` as an anchor
for any of its 9 capabilities, even though the repo's own AI-authored
description says it "emits a UserLoggedInMessage." Because the finance
repo's "Manage user intents" capability *does* anchor `UserLoggedInMessage`
(it consumes the event), the directional asymmetry the heuristic depends on
inverted for that one type, and the finance repo picked up a spurious
substrate flag too. The heuristic is right in shape (anchored-there,
merely-referenced-here) but the input signal (compact capability→entity
anchoring) is too incomplete on real code to carry it alone.

## What this means, plainly

1. **The owner's acceptance criterion is correct and real** — verified
   against actual production code, not a hypothetical. A support/identity
   service's capabilities are genuinely, verifiably separable from a
   product-purpose service's, and the dependency direction between them is
   genuinely, verifiably detectable from blackbox facts (26 shared contract
   types is not a coincidence).
2. **No product surface can run this composition today** — restating the
   complex-case headline finding from this session: there is no reachable
   parent-CAS mechanism in the live product, so this gate cannot run as an
   automated acceptance check against the actual product output yet. It
   was validated by hand and encoded as a harness function ready to wire in
   once composition exists.
3. **The harness gate itself needs a better substrate-detection signal**
   before it can be trusted on real, messy data — not a name blocklist fix,
   but a richer directionality source. The two honest candidates: (a) full
   (not compact) capability-entity anchoring if the hosted CAS exposes it
   under a less-truncated tool, or (b) the actual inter-sub-CAS-node seam
   evidence `docs/cas/SPECIFICATION.md` §0.8 defines — which that same
   specification's own gap register (§0.8.4) says is **not implemented**
   for cross-repo composition yet. Both point back to the same missing
   piece: real seam/dependency evidence, not a proxy built from a compact
   summary shape never designed for this purpose.

## Files

- `apps/mcp-server/src/gauntlet/terminal-capability-gate.ts` — the gate
- `apps/mcp-server/src/gauntlet/terminal-capability-gate.test.ts` —
  fixture-based validation (5/5 green), with the real-data limitation
  documented in the file's own header comment, not glossed over
