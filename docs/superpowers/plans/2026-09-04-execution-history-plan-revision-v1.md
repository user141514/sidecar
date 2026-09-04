# Execution-History-Conditioned Plan Revision V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, evidence-linked plan revision to the current Work Controller and make revised plans affect later orchestration and worker dispatch.

**Architecture:** Extend the existing `work_decide` control plane with a `REVISE` action rather than creating a second planner service. `WorkController` validates and replays plan revisions from the append-only ledger, while the host LLM remains the semantic planner. Existing frontier routing stays deterministic and consumes the latest derived plan.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing WorkLedger/WorkController/MCP/CLI.

**Spec:** `docs/superpowers/specs/2026-09-04-execution-history-plan-revision-v1-design.md`

## Global Constraints

- V1 consumes only the current Work Ledger; no historical cross-task memory.
- No new model, RL, GNN, embeddings, task-complexity score, or utility score.
- Physical delegation depth remains 1.
- Only the coordinator may dispatch workers.
- Existing 120-second serialized dispatch pacing remains unchanged.
- Do not restart DevSpace.
- Preserve legacy ledgers that have no plan snapshot.

---

### Task 1: Plan Revision State Model

**Files:**
- Modify: `src/work-controller.mjs`
- Modify: `test/work-controller.test.mjs`

**Interfaces:**
- Consumes: existing `WorkController.decide(workId, decision)` and append-only ledger events.
- Produces: `REVISE` decision support and derived `currentPlan`, `currentOrchestration`, `planHistory` from `state(workId)`.

- [ ] **Step 1: Add failing tests for a valid revision**

Add a test that submits:

```js
await controller.decide('work_test', {
  action: 'REVISE',
  reason: 'new evidence changed the best route',
  evidence_event_indexes: [1],
  plan: {
    objective: 'resolve the failure',
    approach: 'compare the two surviving hypotheses',
    current_focus: 'falsify hypothesis A',
    assumptions: ['identity is stable'],
    open_questions: ['which lifecycle transition invalidates the binding?']
  },
  orchestration: { mode: 'ADVERSARIAL' }
})
```

Assert `state.currentPlan.version === 1`, `state.currentOrchestration.mode === 'ADVERSARIAL'`, and `state.planHistory.length === 1`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
node --test test/work-controller.test.mjs
```

Expected: failure because `REVISE` is unsupported/current plan fields do not exist.

- [ ] **Step 3: Implement minimal revision normalization/replay**

Add `REVISE` to the action set and validate:

```text
reason: non-empty string
evidence_event_indexes: non-empty unique integer array within current event range
plan.objective: non-empty string
plan.approach: non-empty string
plan.current_focus: non-empty string
plan.assumptions: string[]
plan.open_questions: string[]
orchestration.mode: EXPLORE | EXECUTE | ADVERSARIAL | SYNTHESIZE
```

On replay, derive plan version from accepted `REVISE` event order and never trust a host-supplied version.

- [ ] **Step 4: Add failing validation tests**

Cover at minimum:

```text
REVISE without evidence -> reject
out-of-range evidence index -> reject
unknown orchestration mode -> reject
missing plan field -> reject
host-provided version -> ignored/rejected by schema layer, never persisted
```

- [ ] **Step 5: Run focused tests to GREEN**

Run:

```bash
node --test test/work-controller.test.mjs
```

Expected: all WorkController tests pass.

---

### Task 2: Plan-Aware Worker Dispatch

**Files:**
- Modify: `src/work-controller.mjs`
- Modify: `test/work-controller.test.mjs`

**Interfaces:**
- Consumes: `state.currentPlan` and `state.currentOrchestration` from Task 1.
- Produces: depth-1 worker prompts that include the latest plan context when it exists.

- [ ] **Step 1: Add a failing prompt-context test**

Create a ledger with one accepted `REVISE`, then `SPLIT`, then dispatch a frontier. Assert the sent prompt contains:

```text
Current plan v1
Objective: ...
Approach: ...
Current focus: ...
Orchestration mode: ADVERSARIAL
```

Also assert the existing depth-1/no-recursive-delegation wording remains present.

- [ ] **Step 2: Run focused test and confirm RED**

Run:

```bash
node --test test/work-controller.test.mjs
```

Expected: failure because worker prompt currently contains only the frontier task.

- [ ] **Step 3: Pass derived plan state into `workerPrompt`**

Keep legacy behavior when `currentPlan === null`; no plan is fabricated for old ledgers.

- [ ] **Step 4: Re-run focused tests to GREEN**

Run:

```bash
node --test test/work-controller.test.mjs
```

Expected: all WorkController tests pass.

---

### Task 3: MCP/CLI Contract

**Files:**
- Modify: `src/server.mjs`
- Modify: `test/server.test.mjs`
- Modify: `test/work-cli.test.mjs` only if CLI mapping behavior changes.

**Interfaces:**
- Consumes: existing `work_decide` API.
- Produces: MCP schema that accepts `REVISE` with the exact plan/evidence/orchestration fields; existing `conversation-work decide` continues to pass arbitrary validated JSON to the sidecar.

- [ ] **Step 1: Add a failing server-schema test**

Inspect `tools/list` and assert `work_decide.decision.action.enum` includes `REVISE`, with schema properties for `evidence_event_indexes`, `plan`, and `orchestration`.

- [ ] **Step 2: Run server tests and confirm RED**

Run:

```bash
node --test test/server.test.mjs
```

Expected: schema test fails because only `CONTINUE/SPLIT/PRUNE/STOP` exist.

- [ ] **Step 3: Extend only the existing `work_decide` schema**

Do not add a new MCP tool. Keep `work_state/work_decide/work_dispatch/work_collect` names unchanged.

- [ ] **Step 4: Run server and CLI tests to GREEN**

Run:

```bash
node --test test/server.test.mjs test/work-cli.test.mjs
```

Expected: all pass.

---

### Task 4: Global Skill and Baseline Live Run

**Files:**
- Modify outside repo: `~/.agents/skills/dynamic-work-router/SKILL.md`
- No DevSpace server restart.

**Interfaces:**
- Consumes: `conversation-work create/state/decide/dispatch/collect`.
- Produces: host behavior where a new substantive work item creates an initial `REVISE`, and later material evidence can trigger another `REVISE` before further routing.

- [ ] **Step 1: Update the skill protocol**

For new substantive work, the skill sequence becomes:

```text
conversation-work create
record initial observations if any
conversation-work state
conversation-work decide REVISE(initial plan, evidence)
then CONTINUE/SPLIT/PRUNE as needed
```

After every material observation/worker result/phase boundary:

```text
state -> decide whether current plan still holds -> REVISE if not -> route under the revised plan
```

- [ ] **Step 2: Preserve worker authority boundary**

The skill must continue to state that bounded workers never start the router and never dispatch another worker.

- [ ] **Step 3: Run the full repository test suite**

Run:

```bash
npm test
```

Expected: zero failures.

- [ ] **Step 4: Hot-reload only the sidecar**

Restart the `conversation-sidecar` process if required for source changes. Verify the existing `devspace serve` PID did not change.

- [ ] **Step 5: Perform one real baseline plan-revision cycle**

Create a new work, persist an initial `REVISE`, add a material `observation`, persist a second `REVISE` referencing that observation, then `work_state` must show `currentPlan.version === 2` and both revisions in `planHistory`.

Do not require worker fanout for this baseline; plan revision itself is the behavior under test.
