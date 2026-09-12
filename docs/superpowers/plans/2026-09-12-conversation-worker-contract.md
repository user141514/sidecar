# Conversation Worker Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sidecar unambiguously advertise and emit `conversation_worker` while making its stable CLI equally discoverable from Windows Git Bash and CMD/PowerShell.

**Architecture:** Keep existing WorkController and Runtime Home behavior. Add type evidence to existing dispatch/event receipts, change only the Skill's model-visible identity, and extend the Windows user installer to publish both POSIX and `.cmd` shims from the same stable Runtime Home.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, existing WorkController/WorkLedger/bootstrap installer.

**Spec:** `docs/superpowers/specs/2026-09-12-conversation-worker-contract-design.md`

## Global Constraints

- `conversation_worker` is the only worker kind owned by Sidecar.
- Existing work/conversation/turn identifiers and event types remain compatible.
- The installed Skill directory may remain `chatgpt-subagents`, but its canonical frontmatter name is `conversation-workers`.
- Windows installs both extensionless POSIX and `.cmd` shims; Linux behavior is unchanged.
- No prompt-only routing fix is accepted without machine-readable receipt evidence.

---

### Task 1: Type WorkController dispatch and result evidence

**Files:**
- Modify: `test/work-controller.test.mjs`
- Modify: `src/work-controller.mjs`

**Interfaces:**
- Consumes: existing `WorkController.dispatch(workId, frontierId)` and `collect(workId)`.
- Produces: dispatch results/events/frontier state carrying `worker_kind: 'conversation_worker'` and `backend: 'sidecar'`.

- [ ] **Step 1: Write failing tests** asserting the pacing receipt, accepted dispatch receipt, persisted `worker_dispatched`, derived frontier, uncertain dispatch, and collected `worker_result` expose the two type fields.
- [ ] **Step 2: Run** `node --test test/work-controller.test.mjs` and verify failures are missing-field assertions.
- [ ] **Step 3: Implement** constants and add the fields without changing existing identifiers or statuses:

```js
const WORKER_KIND = 'conversation_worker'
const WORKER_BACKEND = 'sidecar'
```

Use those constants in dispatch return objects, `worker_dispatched` payloads, `worker_result` payloads, and derived frontier state.
- [ ] **Step 4: Run** `node --test test/work-controller.test.mjs` and verify green.

### Task 2: Canonicalize the Sidecar Skill without duplicate installation

**Files:**
- Modify: `skills/chatgpt-subagents/SKILL.md`
- Modify: `install/runtime-user-install.mjs`
- Modify: `test/runtime-user-install.test.mjs`
- Update package/runtime tests that assert the Skill frontmatter if required.

**Interfaces:**
- Consumes: existing `~/.agents/skills/chatgpt-subagents` managed directory.
- Produces: one installed Skill whose frontmatter is `name: conversation-workers`; legacy managed frontmatter remains recognizable for in-place upgrade.

- [ ] **Step 1: Write failing tests** for canonical installed frontmatter and replacement of an existing managed legacy `name: chatgpt-subagents` file.
- [ ] **Step 2: Run** `node --test test/runtime-user-install.test.mjs` and verify the canonical-name expectation fails.
- [ ] **Step 3: Change** tracked Skill frontmatter/description and broaden managed-Skill classification to accept exactly `conversation-workers` or the legacy `chatgpt-subagents` name.
- [ ] **Step 4: Run** the focused installer/package tests and verify green.

### Task 3: Publish Windows dual-shell stable shims

**Files:**
- Modify: `install/runtime-user-install.mjs`
- Modify: `test/runtime-user-install.test.mjs`

**Interfaces:**
- Consumes: stable Runtime Home `bin/chatgpt-conversation`, `bin/chatgpt-conversation.cmd`, `bin/conversation-work`, `bin/conversation-work.cmd`.
- Produces on Windows: both extensionless and `.cmd` user shims for each command.

- [ ] **Step 1: Write failing tests** requiring four Windows command paths, foreign-conflict preflight for each form, idempotence, and a Git Bash execution fixture that reaches the extensionless Runtime Home launcher.
- [ ] **Step 2: Run** `node --test test/runtime-user-install.test.mjs` and verify missing extensionless shim failures.
- [ ] **Step 3: Implement** a `commandFiles(platform, command)` mapping and separate POSIX/CMD shim bodies. The Windows POSIX shim converts the stable Runtime Home target with `cygpath -u` before `exec`.
- [ ] **Step 4: Re-run** focused tests, then `npm test`, `npm run build:runtime`, and `npm run verify:runtime`.

### Task 4: Final acceptance

**Files:** no new production files.

- [ ] **Step 1:** Run `npm test` and require zero failures.
- [ ] **Step 2:** Run runtime build/verification and require success.
- [ ] **Step 3:** Run the installed extensionless Sidecar command from Git Bash with `--help` in a disposable install or current Runtime Home; require normal help output rather than `command not found`.
- [ ] **Step 4:** Inspect `git diff --check` and final diff for unrelated changes.
