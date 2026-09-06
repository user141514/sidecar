# Unified Mainline Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize conversation-sidecar onto one shared Linux/Windows mainline without touching the locally proven running package, while preserving only verified feature increments from the superseded Windows branch.

**Architecture:** `origin/feat/shared-extension-update@081bff5` is the stabilization base because it already contains the shared conversation protocol, WorkLedger, WorkController, MemoryPool, exact-turn collection, cross-platform Native Messaging link layer, extension update/reload fencing, standalone packaging, and Windows tests. OS differences remain confined to `install/` and launcher paths. The old Windows branch is archival evidence only; useful feature increments are reimplemented test-first against the unified architecture rather than merged wholesale.

**Tech Stack:** Node.js >=24 ESM, Chrome MV3, Native Messaging, node:test, append-only JSON/JSONL, Git worktrees.

**Specs:**
- `docs/superpowers/specs/2026-09-04-cross-platform-sidecar-link-layer-design.md`
- `docs/superpowers/specs/2026-09-03-managed-worker-transaction-model.md`
- `docs/superpowers/specs/2026-09-04-execution-history-plan-revision-v1-design.md`
- `docs/superpowers/specs/2026-09-04-memory-pool-v1-design.md`

## Global Constraints

- Do not modify or replace the locally proven running Sidecar/Chrome package, profile, Native Messaging runtime, or Orca runtime during source normalization.
- One shared product mainline owns conversation protocol, extension, MCP, WorkLedger, WorkController, MemoryPool, and Skill behavior.
- Platform-specific code is limited to Native Messaging installation/process launch and filesystem path translation.
- `archive/win-pre-normalize-20260906@e53895d` is recovery evidence, not an integration base.
- Never merge or cherry-pick `f521bcc`, `fe481b1`, or `e53895d` wholesale into the stabilization branch.
- Every retained behavior must enter the unified branch through a failing test, minimal implementation, focused tests, then the full repository suite.
- No remote branch deletion, force-push, or `main` promotion until the stabilization branch passes source tests plus bounded Windows and Mint live gates.

---

### Task 1: Freeze and verify the unified baseline

**Files:**
- Existing branch: `stabilize/unified-mainline-20260906`
- Create: `docs/superpowers/plans/2026-09-06-unified-mainline-stabilization.md`

**Interfaces:**
- Consumes: `origin/feat/shared-extension-update@081bff5`
- Produces: a documented clean Windows-tested stabilization base.

- [x] **Step 1: Preserve the superseded Windows dirty state**

Recovery branch and commit:

```text
archive/win-pre-normalize-20260906
e53895d wip:preserve-pre-normalization-app-routing
```

- [x] **Step 2: Create/reuse an isolated stabilization worktree**

```text
C:/Users/14579/.devspace/worktrees/multi-conversation-eefbbb6b
branch: stabilize/unified-mainline-20260906
base: 081bff5
```

- [x] **Step 3: Run the full Windows baseline suite**

Run:

```text
npm test
```

Expected: zero failures. Observed on 2026-09-06: 132 tests, 130 pass, 0 fail, 2 skip.

- [x] **Step 4: Commit this stabilization plan**

```text
git add docs/superpowers/plans/2026-09-06-unified-mainline-stabilization.md
git commit -m docs:record-unified-mainline-stabilization
```

---

### Task 2: Reintroduce per-message ChatGPT App selection on the unified API

**Files:**
- Modify: `src/conversation-tools.mjs`
- Modify: `src/chatgpt.mjs`
- Modify: `src/cli.mjs`
- Modify: `extension/service-worker.js`
- Modify: `extension/content-script.js`
- Test: `test/chatgpt.test.mjs`
- Test: `test/cli.test.mjs`
- Test: `test/content-script-runtime.test.mjs`
- Test: `test/extension-runtime.test.mjs`
- Test: `test/server.test.mjs`

**Interfaces:**
- Consumes: existing `conversation_send { conversation_id, text }` and `ChatGptConversationHost.send(conversationId, text)`.
- Produces: optional `app: string` propagated end-to-end without changing default send behavior.

- [x] **Step 1: Add failing MCP/CLI/host tests**

Required assertions:

```text
conversation_send inputSchema.properties.app.type === 'string'
CLI: send <id> --app DevSpace <prompt> -> { conversation_id, text, app: 'DevSpace' }
ChatGptConversationHost.send(id, text, { app: 'DevSpace' }) persists app on prompt_sent and forwards app to conversation_send bridge request.
```

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```text
node --test test/chatgpt.test.mjs test/cli.test.mjs test/server.test.mjs
```

Expected: failures only for missing `app` support.

- [x] **Step 3: Implement shared host/MCP/CLI propagation**

Rules:

```text
app is optional
if present, it must be a non-empty string
existing callers without app are unchanged
WorkController continues to call send(conversationId, prompt) with no app by default
```

- [x] **Step 4: Add failing browser transport tests**

Required assertions:

```text
service worker forwards app to the exact conversation_send content-script message
content script selects the requested app before setting/submitting prompt text
missing app keeps the existing send path unchanged
missing requested app fails closed before prompt submission
```

- [x] **Step 5: Run browser-focused tests and confirm RED**

Run:

```text
node --test test/content-script-runtime.test.mjs test/extension-runtime.test.mjs
```

- [x] **Step 6: Implement minimal browser app selection**

Use the current ChatGPT composer tools menu only. No platform branches, no CDP, no new dependency, no Project/sidebar redesign.

- [x] **Step 7: Run focused GREEN tests**

Run the five touched test files and require zero failures.

- [x] **Step 8: Commit the verified app-selection feature**

```text
git add src/conversation-tools.mjs src/chatgpt.mjs src/cli.mjs extension/service-worker.js extension/content-script.js test/chatgpt.test.mjs test/cli.test.mjs test/content-script-runtime.test.mjs test/extension-runtime.test.mjs test/server.test.mjs
git commit -m feat:add-per-message-chatgpt-app-selection
```

---

### Task 3: Full source verification and branch audit

**Files:**
- No product code unless a failing test reveals a real regression.

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: one clean candidate branch with explicit supersession evidence.

- [x] **Step 1: Run full suite**

```text
npm test
```

Expected: zero failures.

- [x] **Step 2: Run whitespace/integrity gate**

```text
git diff --check
```

Expected: no output.

- [x] **Step 3: Audit branch delta**

Confirm:

```text
stabilize/unified-mainline-20260906 contains shared scheduler/memory/platform history
archive/win-pre-normalize-20260906 remains recoverable
origin/feat/chatgpt-conversation-win remains untouched
no product dependency exists on f521bcc/fe481b1-only implementation files
```

- [ ] **Step 4: Commit only if verification required code changes**

Do not create a meaningless verification commit.

---

### Task 4: Disposable Windows live gate

**Files:**
- No changes to the locally proven running package.
- Use a disposable manifest/profile/install target if a real host gate is needed.

**Interfaces:**
- Consumes: verified stabilization source.
- Produces: proof that source can operate on Windows without replacing the known-good installation.

- [ ] **Step 1: Verify installer output in a temporary/disposable target**
- [ ] **Step 2: Verify native host starts and preserves stdio**
- [ ] **Step 3: Perform one bounded create/send/read conversation gate**
- [ ] **Step 4: If app selection is part of the target release, perform one bounded `app=DevSpace` send**
- [ ] **Step 5: Remove only disposable gate resources; do not touch the proven package**

---

### Task 5: Mint/Linux parity gate and mainline promotion preparation

**Files:**
- No platform-specific application fork.

**Interfaces:**
- Consumes: same commit proven on Windows.
- Produces: one commit SHA eligible for PR/main promotion.

- [ ] **Step 1: Run the exact same commit on Mint/Linux**
- [ ] **Step 2: Run `npm test` and Native Messaging installer checks**
- [ ] **Step 3: Run one bounded create/send/read gate**
- [ ] **Step 4: Record the single candidate SHA that passed both hosts**
- [ ] **Step 5: Prepare PR/promotion; do not force-push or delete remote branches as part of stabilization**

After promotion, legacy Windows/Linux feature branches become archival only. Future application changes land once on the shared mainline; only `install/` and launcher/path adapters may branch on OS.
