# Unified Conversation Runtime — Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sidecar the sole authoritative conversation-state reducer and dispatcher for Sidebar, Watchdog, and Coordinator intents while preserving the existing mailbox/EffectReceipt safety model.

**Architecture:** Introduce a versioned pure contract layer first, then add a durable authoritative state projection, then route versioned intents through the existing mailbox dispatcher. Browser extension responsibilities are narrowed to observation/command/effect-receipt semantics. NEW/REUSE remain explicit intent choices.

**Tech Stack:** Node 24 ESM, existing append-only ConversationStore, existing Chrome extension, existing SendMailbox and EffectReceipt logic.

**Spec:** `../specs/2026-09-16-unified-conversation-runtime-design.md`

## Global Constraints

- Only devnbook9; do not change pc1/dcomd7.
- Preserve the current single-writer mailbox, durable EffectReceipt, >=120s pacing, and fail-closed delivery uncertainty.
- No new broker/daemon/dependency.
- No hidden AUTO allocation policy.
- Every task uses RED -> minimal GREEN -> focused regression -> software-engineering audit -> commit.
- Every audit records `Claim | Model | Invariant | Counterexample | Evidence` in the task review package.
- Cross-project contract changes require Watchdog contract tests before the slice is accepted.

---

### Task 1: Versioned conversation contract

**Files:**
- Create: `src/conversation-contract.mjs`
- Create: `test/conversation-contract.test.mjs`
- Create: `test/fixtures/conversation-runtime-v1.json`
- Modify: export/runtime file lists only if required for package inclusion.

**Interfaces:**
- Produces: `CONVERSATION_CONTRACT_VERSION = 1`
- Produces: `parseObservation(value)`, `parseConversationState(value)`, `parseIntentEnvelope(value)` pure validators returning normalized immutable objects or throwing `TypeError`.
- Consumes: exact field/value semantics from the canonical spec.

- [ ] **Step 1: Write RED contract tests**
  - valid v1 observation/state/intent fixtures parse identically;
  - unknown contract version fails closed;
  - extra fields fail closed;
  - `REUSE` without target/conversation fails;
  - existing-conversation state-changing intent without `expectedStateVersion` fails;
  - `UNKNOWN` cannot be represented as terminal/retryable by parser coercion.

- [ ] **Step 2: Run RED**
  - `node --test test/conversation-contract.test.mjs`
  - Expected: fail because module does not exist.

- [ ] **Step 3: Implement minimal pure contract module**
  - no store, bridge, browser, clock, or I/O imports;
  - freeze normalized nested objects;
  - exact enumerations from spec.

- [ ] **Step 4: Run focused tests**
  - `node --test test/conversation-contract.test.mjs`
  - Expected: all pass.

- [ ] **Step 5: Cross-project gate**
  - Run Watchdog `tests/test_contracts.py` against the same semantic fixture cases.
  - Reject slice if field names, enums, version, or stale-state requirements differ.

- [ ] **Step 6: Software-engineering audit**
  - Counterexamples: unknown version, future extra field, stale stateVersion, target alias, missing identity.
  - Evidence: no production call sites changed; existing full suite unchanged.

- [ ] **Step 7: Commit**
  - `git commit -m "feat: define conversation runtime v1 contract"`

### Task 2: Authoritative Sidecar state reducer

**Files:**
- Create: `src/conversation-state.mjs`
- Modify: `src/chatgpt.mjs`
- Modify: `src/store.mjs` only for durable projection/event support.
- Modify: `extension/content-script.js` / `extension/service-worker.js` only if a missing observation field is required.
- Test: `test/conversation-state.test.mjs`, focused delivery/completion tests.

**Interfaces:**
- Consumes: v1 Observation plus current ConversationStore events.
- Produces: `reduceConversationState({ledger, observations}) -> ConversationStateV1`.
- Produces: `conversation_state` read path returning authoritative state with monotonic `stateVersion`.

- [ ] RED: ledger `generating` + live stopped shell-only -> durable `blocked/incomplete`.
- [ ] RED: ledger `generating` + exact valid terminal substantive body -> durable `terminal/substantive`.
- [ ] RED: unreadable/missing exact observation -> `unknown`, never terminal.
- [ ] RED: EffectReceipt changes delivery identity only, never completion.
- [ ] Implement pure reducer first; then wire `ChatGptConversationHost.read()` to reconcile nonterminal stale states rather than only `delivery_uncertain`/`completed`.
- [ ] Verify no reducer path sends or mutates browser state.
- [ ] Audit stale/duplicate/out-of-order observations and exact-turn identity binding.
- [ ] Commit `feat: add authoritative conversation state reducer`.

### Task 3: Versioned intent dispatcher

**Files:**
- Modify: `src/chatgpt.mjs`
- Modify: `src/server.mjs`
- Modify: `src/conversation-tools.mjs`
- Test: `test/conversation-intents.test.mjs`, `test/server.test.mjs`, new dispatcher contract tests.

**Interfaces:**
- Consumes: `IntentEnvelopeV1`.
- Requires: `expectedStateVersion` and writer epoch for existing-conversation mutations.
- Produces: typed result `{accepted, reason, currentStateVersion, ...}`.

- [ ] RED: state N intent rejected after reducer advances to N+1 before dispatch.
- [ ] RED: human gate and writer epoch mismatch reject before pacing/effect reservation.
- [ ] RED: independent conversation UNKNOWN does not globally block unrelated conversation intent.
- [ ] Route current Watchdog endpoint through contract parser and authoritative state check while preserving old v0 adapter temporarily.
- [ ] Keep final exact message-id/browser guard immediately before irreversible effect.
- [ ] Audit TOCTOU: validation after pacing and before mailbox effect dispatch.
- [ ] Commit `feat: dispatch versioned conversation intents`.

### Task 4: Sidebar/browser driver boundary and explicit allocation

**Files:**
- Modify: `extension/content-script.js`
- Modify: `extension/service-worker.js`
- Modify: Sidecar conversation/work APIs as required.
- Test: extension runtime, WorkController, allocation tests.

**Interfaces:**
- Sidebar/human produces intent; Extension exposes observations and executes commands.
- NEW and REUSE are explicit; AUTO rejected as unsupported.

- [ ] RED: NEW never logically reuses an old child even if old thread is used as navigation seed.
- [ ] RED: REUSE requires exact conversation and successful authoritative reconciliation first.
- [ ] RED: REUSE against active/blocked-human/unknown state fails closed.
- [ ] Separate project/tab discovery from logical allocation decision.
- [ ] Ensure Sidebar-visible state is derived from authoritative Sidecar state, not local DOM phase.
- [ ] Audit context contamination and allocation ownership; no automatic saturation heuristic.
- [ ] Commit `refactor: separate browser driver from child allocation policy`.

### Task 5: Remove duplicate authority and integrate

**Files:**
- Remove/deprecate duplicate local lifecycle decisions only after Watchdog migration is complete.
- Update docs/runtime exports as required.

- [ ] Run Sidecar full suite and extension build verification.
- [ ] Run Watchdog full suite against new Sidecar contract.
- [ ] Run real controlled acceptance for: fresh NEW child, exact-thread REUSE, stale-generating reconciliation, Watchdog continuation, human gate.
- [ ] Adversarial final review across both branch diffs.
- [ ] Deploy Sidecar first with compatibility adapter; verify Runtime Home/build/instance/pending/outbox.
- [ ] Deploy Watchdog consumer only after Sidecar acceptance.
- [ ] Remove compatibility adapter in a later explicit slice, not in the same rollout.
