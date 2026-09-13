# Global Send Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the managed 120-second send-spacing invariant behind one durable Sidecar-owned admission contract and make Watchdog direct continuation consume that contract.

**Architecture:** Sidecar's existing server owns one durable admission record under Runtime Home data. Manual Sidecar sends and WorkController use the same in-process owner; Watchdog uses a localhost-only internal HTTP endpoint. No new service or model-facing tool is added.

**Tech Stack:** Node.js ESM, Python 3.12, built-in node:test/unittest, existing Sidecar HTTP server and Watchdog Supervisor.

**Spec:** `docs/superpowers/specs/2026-09-13-global-send-admission-design.md`

## Global Constraints

- Minimum managed send interval: 120000 ms.
- Admission survives Sidecar restart.
- Admission denial is fail-closed.
- No new daemon, registry, or task database.
- Standalone legacy Watchdog may omit the shared admission contract but then makes no global-spacing claim.

---

### Task 1: Durable Sidecar admission owner

**Files:**
- Create: `src/send-admission.mjs`
- Create: `test/send-admission.test.mjs`

**Interfaces:**
- `new SendAdmission({ statePath, intervalMs, now })`
- `admit({ source, target }) -> { admitted, admittedAt?, retryAfterMs? }`

- [x] Write tests for first grant, denial inside 120s, grant after 120s, concurrent serialization, and restart durability.
- [x] Run the focused test and verify RED.
- [x] Implement the minimal durable JSON record with serialized admission.
- [x] Run the focused test and verify GREEN.

### Task 2: Sidecar send paths consume one owner

**Files:**
- Modify: `src/chatgpt.mjs`
- Modify: `src/work-controller.mjs`
- Modify: `src/server.mjs`
- Modify: `test/chatgpt.test.mjs`
- Modify: `test/work-controller.test.mjs`
- Modify: `test/server.test.mjs`

**Interfaces:**
- `ChatGptConversationHost.admitSend({ source, target })`
- `send(..., { preAdmitted })` for WorkController's already-granted send only.
- Internal `POST /internal/send-admission` on localhost.

- [x] Add failing tests proving manual send denial, WorkController admission before allocation, and internal endpoint use the same owner.
- [x] Run focused tests and verify RED.
- [x] Wire the shared admission owner without exposing a model-facing tool.
- [x] Run focused tests and verify GREEN.

### Task 3: Watchdog direct continuation uses Sidecar admission

**Files (Watchdog repo):**
- Modify: `chat_watchdog/cli.py`
- Modify: `chat_watchdog/supervisor.py`
- Add or modify focused tests under `tests/`.

**Interfaces:**
- Optional configured admission client to Sidecar internal endpoint.
- Admission denied/unavailable -> `WAITING`/blocked, never direct send or unadmitted recovery.

- [x] Add failing tests for admitted, denied, unavailable, and legacy-unconfigured modes.
- [x] Run focused Watchdog tests and verify RED.
- [x] Implement the minimal client/injection.
- [x] Run Watchdog focused/full tests and verify GREEN.

### Task 4: Integration verification

- [ ] Run full Sidecar suite from a clean worktree.
- [ ] Run full Watchdog suite using its installed venv interpreter.
- [ ] Verify source diffs and build identity.
- [ ] Do not deploy until source verification is green; deployment convergence is the next separate task.
