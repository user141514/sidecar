# Cross-Platform Sidecar Link Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current Sidecar branch install and start from the same commit on Linux and Windows by isolating only Native Messaging/path/process differences.

**Architecture:** Keep the complete Sidecar application runtime shared. Add one Node native-host installer as the platform link layer, plus the minimum POSIX/Windows launchers. Validate both platform branches from the same code using injected unit tests and a real isolated Windows worktree.

**Tech Stack:** Node.js 24+, Chrome Native Messaging, POSIX shell, Windows cmd/Registry, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-04-cross-platform-sidecar-link-layer-design.md`

## Global Constraints

- `com.conversation_sidecar.host` and extension ID `cfifihieaffhniimpimnfmignbbdaalb` remain unchanged.
- Work/Memory/Controller/MCP/Skill behavior must not change.
- Do not modify the dirty Windows checkout.
- Do not import Windows branch `mcp-client`, `mcp-cli`, `mcp-stdio` hardening, or current `--app` work.
- One source file (`install/install-host.mjs`) owns OS selection; no general platform framework.

---

### Task 1: Native Messaging platform link

**Files:**
- Create: `test/native-host-installer.test.mjs`
- Create: `install/install-host.mjs`
- Create: `install/conversation-sidecar-host`
- Create: `install/conversation-sidecar-host.bat`
- Create: `install/install-host-win.bat`
- Delete: `install/com.conversation_sidecar.host.json`

**Interfaces:**
- Produces: `installNativeHost(options) -> manifestPath`
- Produces: `resolveWindowsLocalAppData({ userProfileDirectory }) -> string`

- [ ] **Step 1: Write failing installer tests** covering Linux manifest output, Windows manifest output + registry call, `%USERPROFILE%/AppData/Local` selection, unsupported platform rejection, and launcher contents.
- [ ] **Step 2: Run the focused tests and confirm RED** because the shared installer/launchers do not exist.
- [ ] **Step 3: Implement the minimum installer and launchers** by adapting the already-proven Windows branch behavior without importing unrelated branch changes.
- [ ] **Step 4: Run focused tests and confirm GREEN.**

### Task 2: Shared runtime entrypoint portability

**Files:**
- Modify: `src/server.mjs`
- Create: `test/windows-runtime.test.mjs`

**Interfaces:**
- Consumes: the same `src/server.mjs` from both launchers.

- [ ] **Step 1: Write a failing test** asserting the Windows launcher preserves stdio and direct server startup is valid on win32; also statically guard the cross-platform main-entry comparison.
- [ ] **Step 2: Confirm RED** against the Linux-specific `new URL(import.meta.url).pathname` comparison.
- [ ] **Step 3: Change only the direct-entry comparison** to `fileURLToPath(import.meta.url) === process.argv[1]`.
- [ ] **Step 4: Run focused runtime tests.**

### Task 3: User-facing install surface

**Files:**
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: `npm run install:host` on both Linux and Windows.
- Windows also retains `install\\install-host-win.bat` for cmd users.

- [ ] **Step 1: Add one cross-platform npm install command** pointing to `node install/install-host.mjs`.
- [ ] **Step 2: Rewrite the installation section** around one shared runtime with Linux and Windows edges; do not rewrite unrelated architecture docs.
- [ ] **Step 3: Run `git diff --check`.**

### Task 4: Linux verification and adversarial review

**Files:** no new production files unless a contract-breaking issue is found.

- [ ] **Step 1: Run `npm test`.**
- [ ] **Step 2: Run `git diff --check`.**
- [ ] **Step 3: Run one focused OMP read-only audit** only if additional independent review is still needed; the already-created GPT child is not reused because its first result was unusable.
- [ ] **Step 4: Fix only contract-breaking findings, then rerun the full suite.**

### Task 5: Real Windows verification without touching the dirty Windows branch

**Files:** no modifications in the existing `E:\\Dev\\multi-conversation` checkout.

- [ ] **Step 1: Commit and push the unified Linux-branch implementation** after Linux verification.
- [ ] **Step 2: On `devinbook8`, create an isolated worktree from that pushed commit/ref.**
- [ ] **Step 3: Run `npm test` in the isolated Windows worktree.**
- [ ] **Step 4: Confirm Windows direct-start/launcher tests run on win32.**
- [ ] **Step 5: Do not perform real registry mutation unless explicitly gated; simulated registration is sufficient for this baseline.**
- [ ] **Step 6: If both hosts pass, record the evidence in the current Work Ledger and stop. Main-branch integration is a separate decision.**
