# Memory Auto Sync V0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically kick the already-proven local-memory uploader after durable MemoryPool publication and once at Sidecar startup, while keeping online sync outside task-completion latency.

**Architecture:** Add a standalone `MemorySyncBridge` that validates a local `mymem` checkout, serializes/coalesces uploader runs, and schedules transient retries. Wire it into Sidecar only after its independent tests pass. The existing `mymem/scripts/upload-local-memory.mjs` remains the data-plane implementation.

**Tech Stack:** Node.js ESM, Node standard library, existing Sidecar MemoryPool/HTTP server, existing mymem uploader, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-10-memory-auto-sync-v0-design.md`

## Global Constraints

- Local MemoryPool durability is the task-completion boundary.
- Git/network work must never be awaited by `work_append(type=completed)`.
- Only a local Git checkout whose `origin` is `github.com/user141514/mymem` and contains `scripts/upload-local-memory.mjs` is eligible.
- No watcher daemon, persistent retry queue, deploy-key authority, PR verifier, or new authentication layer.
- One OMP read-only audit runs after each of the four execution tasks and may only report concrete defects in that task's bounded change.

---

### Task 1: Fixed mymem prerequisite

**Files:** none

**Interfaces:**
- Consumes: `/home/ad/gitproject/mymem`, `origin/main`, `scripts/upload-local-memory.mjs`.
- Produces: a fixed checkout on current `main` that can execute the uploader against Sidecar `data/memory`.

- [x] Fetch `origin/main` and fast-forward the fixed checkout to it.
- [x] Verify branch `main`, correct origin identity, uploader presence, and one real `up_to_date` run.
- [x] Run one bounded OMP consistency audit and require PASS before Task 2.

### Task 2: Standalone MemorySyncBridge

**Files:**
- Create: `src/memory-sync-bridge.mjs`
- Create: `test/memory-sync-bridge.test.mjs`

**Interfaces:**
- Produces: `MemorySyncBridge` with `kick()` and `whenIdle()`; constructor accepts `memoryRoot`, `mymemRepo`, `retryDelayMs`, `runUploader`, `scheduleRetry`, and `logger` test seams.
- Default runner executes `<mymemRepo>/scripts/upload-local-memory.mjs --source <memoryRoot>` using Node.

- [ ] Write failing tests for valid-repo upload, wrong/missing repo disable, single-flight/coalescing, and delayed retry.
- [ ] Run `node --test test/memory-sync-bridge.test.mjs` and verify RED because the module is absent.
- [ ] Implement the minimal bridge.
- [ ] Run the focused test to GREEN.
- [ ] Run one bounded OMP audit of only the bridge semantics; fix only concrete P0/P1 defects and rerun focused tests.

### Task 3: Sidecar trigger wiring

**Files:**
- Modify: `src/memory-pool.mjs`
- Modify: `src/server.mjs`
- Modify: `test/memory-pool.test.mjs`
- Modify: `test/server.test.mjs`

**Interfaces:**
- `MemoryPool` accepts a synchronous `onPublished` callback and invokes it only after durable local publication succeeds, including idempotent publish calls; it does not await any work started by that callback.
- `createRuntimeComponents(...)` creates and returns `memorySyncBridge` using the same memory root as `MemoryPool`, and wires `onPublished` to `memorySyncBridge.kick()`.
- `createSidecarServer(...).listen()` kicks once after the HTTP server is listening.

- [ ] Add failing tests proving successful MemoryPool publish invokes `onPublished` after local durability, completion does not await deferred bridge work, and server listen performs one startup kick.
- [ ] Run focused memory/server tests to verify RED.
- [ ] Wire the callback and startup kick minimally.
- [ ] Run `node --test test/server.test.mjs test/memory-pool.test.mjs test/memory-sync-bridge.test.mjs` to GREEN.
- [ ] Run one bounded OMP audit of only trigger placement/completion semantics; fix only concrete P0/P1 defects and rerun focused tests.

### Task 4: Live automatic-sync gate

**Files:** no new production files unless a concrete defect is found.

**Interfaces:**
- Uses the running Sidecar, fixed `/home/ad/gitproject/mymem`, and GitHub `mymem/main`.

- [ ] Create one terminal work through the live Sidecar, STOP it, and complete it to create a genuinely new local memory record.
- [ ] Verify completion response returns while online sync is not part of its critical path.
- [ ] Observe bridge/uploader convergence and refetch GitHub main.
- [ ] Verify the exact `(memory_id, record_sha256)` is present online.
- [ ] Run the full relevant test set and verify 0 failures.
- [ ] Run one final bounded OMP live-evidence audit; accept only concrete discrepancies in the observed path.
- [ ] Commit/push the Sidecar implementation branch after all four gates pass.
