# Low-Frequency Historical Memory Pool V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an immutable, explicitly published local memory pool over terminal Work Ledgers, with deterministic query and explicit consumption provenance.

**Architecture:** Add one `MemoryPool` module beside `WorkLedger` and inject it into the existing sidecar server. `MemoryPool` copies completed work trajectories by value into `data/memory`, scans the append-only manifest for deterministic queries, and writes `memory_query` / `memory_consumed` provenance back to the current Work Ledger. Existing `REVISE`, dispatch, and worker prompting stay unchanged.

**Tech Stack:** Node.js ESM, standard library only (`fs/promises`, `crypto`, `path`), existing MCP HTTP server and CLI.

**Spec:** `docs/superpowers/specs/2026-09-04-memory-pool-v1-design.md`

## Global Constraints

- No automatic publication from work completion or any hook.
- Only `STOP + completed` terminal work may publish.
- Published records are immutable copied snapshots.
- No ranking, embedding, top-k, similarity score, or auto-injection.
- Query and actual consumption must be separately persisted in the current Work Ledger.
- Historical memory is optional; current-trajectory-only behavior remains the default baseline.
- Do not restart DevSpace; only sidecar may be hot-reloaded if required.

---

### Task 1: MemoryPool immutable publication

**Files:**
- Create: `src/memory-pool.mjs`
- Create: `test/memory-pool.test.mjs`
- Modify: `src/work-ledger.mjs`

**Interfaces:**
- Consumes: `WorkLedger.read(workId)`, `WorkLedger.append(workId, type, payload)`
- Produces: `new MemoryPool({ rootDir, workLedger, now?, randomId? })`, `publish(sourceWorkId)`, `query(workId, query)`, `read(workId, retrievalId, memoryId)`

- [ ] Write failing publication tests covering terminal-only publication, copied immutable event bytes, manifest revision/hash provenance, and duplicate idempotency.
- [ ] Run `node --test test/memory-pool.test.mjs` and confirm failures are caused by the missing module/behavior.
- [ ] Implement the minimum filesystem publisher with manifest appended only after record files are complete.
- [ ] Add `memory_query` and `memory_consumed` to internal WorkLedger event types.
- [ ] Re-run `node --test test/memory-pool.test.mjs` and make publication tests pass.

### Task 2: Deterministic query and explicit consumption

**Files:**
- Modify: `src/memory-pool.mjs`
- Modify: `test/memory-pool.test.mjs`

**Interfaces:**
- `query(workId, { contains? }) -> { retrievalId, poolRevision, manifestSha256, available, matched, matches }`
- `read(workId, retrievalId, memoryId) -> { meta, events }`

- [ ] Add failing tests proving literal case-sensitive query semantics, zero-match logging, available-vs-matched provenance, and no ranking/truncation.
- [ ] Add failing tests proving `read` only accepts a memory returned by the named retrieval and appends `memory_consumed`.
- [ ] Implement query as a frozen manifest scan and read as a hash-verified immutable record load.
- [ ] Re-run the focused tests until green.

### Task 3: MCP wiring

**Files:**
- Modify: `src/server.mjs`
- Modify: `test/server.test.mjs`

**Interfaces:**
- `work_memory_publish { source_work_id }`
- `work_memory_query { work_id, contains? }`
- `work_memory_read { work_id, retrieval_id, memory_id }`

- [ ] Add failing tools-list and dispatch tests for all three tools.
- [ ] Inject `memoryPool` into `createSidecarServer` and `startDefault`, defaulting its root to `data/memory/`.
- [ ] Keep generic `work_append` restricted to coordinator `action/observation/completed`; memory events are internal only.
- [ ] Run `node --test test/server.test.mjs` until green.

### Task 4: CLI exposure

**Files:**
- Modify: `src/work-cli.mjs`
- Modify: `test/work-cli.test.mjs`

**Interfaces:**
- `conversation-work memory-publish <source_work_id>`
- `conversation-work memory-query <work_id> <query_json>`
- `conversation-work memory-read <work_id> <retrieval_id> <memory_id>`

- [ ] Add failing CLI mapping and malformed/empty-argument tests.
- [ ] Implement only the three command mappings using the existing MCP client.
- [ ] Run `node --test test/work-cli.test.mjs` until green.

### Task 5: Skill integration

**Files:**
- Modify: `/home/ad/.agents/skills/dynamic-work-router/SKILL.md`

**Interfaces:**
- Current-trajectory-only remains default.
- Historical memory flow is explicit `memory-query -> memory-read -> state -> optional REVISE citing memory_consumed event`.

- [ ] Run a fresh-model baseline against the current skill and confirm it does not know the new memory commands.
- [ ] Add the minimum optional historical-memory section; do not make memory mandatory.
- [ ] Re-run the fresh-model scenario and confirm it distinguishes query availability from consumed memory and cites consumption before revision.

### Task 6: Verification and adversarial review

**Files:**
- No new production files expected.

- [ ] Run `npm test` and `git diff --check`.
- [ ] Run one focused OMP read-only adversarial audit against publication immutability, retrieval provenance, experiment leakage, and MCP/CLI trust boundaries.
- [ ] Fix only contract-breaking findings with RED->GREEN regression tests.
- [ ] Hot-reload sidecar only; verify DevSpace PID did not change.
- [ ] Publish one already-completed historical Work Ledger and run one live query/read on the current work to prove available -> matched -> consumed provenance.
- [ ] Record final evidence in the current Work Ledger and stop the implementation work.
