# Portable Agent Runtime Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a portable full Agent Runtime that installs from one verified source checkout into a stable Runtime Home, keeps conversations/works/memory outside Git, forces managed workers into the canonical `subagents` Project, and converges through an idempotent bootstrap command on Windows and Linux.

**Architecture:** Keep the existing provider artifact transport-only. Add a separate immutable full-runtime artifact that includes WorkLedger, WorkController, MemoryPool and their CLI surface. A stable Runtime Home owns `runtime.json`, immutable releases, stable launchers and persistent data. Bootstrap prepares/activates that Runtime Home in explicit phases and never silently replaces an external working installation or guesses between ambiguous legacy data roots.

**Tech Stack:** Node.js >=24 ESM, Chrome MV3, Native Messaging, `node:test`, append-only JSON/JSONL, Git provenance, Windows cmd + POSIX shell launchers.

**Spec:** `docs/superpowers/specs/2026-09-06-agent-runtime-bootstrap-design.md`

## Global Constraints

- Authoritative Windows integration workspace: `C:/Users/14579/.devspace/worktrees/multi-conversation-eefbbb6b` on `stabilize/unified-mainline-20260906`.
- Immutable baseline ref: `baseline/win-integration-20260906`.
- Existing provider artifact remains transport-only; do not add WorkController or MemoryPool to `build:provider`.
- Runtime data must not depend on a Git checkout after bootstrap.
- Managed `WorkController` dispatch requires a canonical `subagents` Project URL and must fail closed when unresolved.
- Platform branching is restricted to path/launcher/Native-Messaging/PATH adapters; no OS branch in WorkController, MemoryPool, ConversationStore or managed-project policy.
- Existing active Native Messaging registrations outside Runtime Home are preserved unless `--activate` is supplied.
- Legacy data migration is copy-only and ambiguity fails closed.
- Orca/orca-sub orchestration-protocol extraction is out of scope.
- Every product change follows RED -> minimal GREEN -> focused tests -> full suite -> commit.

---

### Task 1: Add the immutable full Agent Runtime artifact

**Files:**
- Create: `scripts/export-runtime.mjs`
- Create: `scripts/verify-runtime.mjs`
- Create: `test/runtime-package.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `providerFiles`, normalized hashing behavior, `checkedExtensionBuild()` and Git provenance from the existing provider export.
- Produces: `exportRuntime(destination)`, `runtimeFiles`, `verifyRuntime(directory)`, `npm run build:runtime`, `npm run verify:runtime`.

- [ ] **Step 1: Write the failing runtime-package test**

Add `test/runtime-package.test.mjs` asserting all of the following:

```js
const exporter = await import('../scripts/export-runtime.mjs').catch(() => ({}))
assert.equal(typeof exporter.exportRuntime, 'function')

const verifier = await import('../scripts/verify-runtime.mjs').catch(() => ({}))
assert.equal(typeof verifier.verifyRuntime, 'function')

for (const path of [
  'src/server.mjs',
  'src/work-ledger.mjs',
  'src/work-controller.mjs',
  'src/work-cli.mjs',
  'src/memory-pool.mjs',
  'src/chatgpt.mjs',
  'extension/manifest.json',
  'install/platform-link.mjs',
  'skills/chatgpt-subagents/SKILL.md'
]) await access(join(output, path))

for (const path of ['data', '.git']) await assert.rejects(access(join(output, path)))
assert.equal((await verifier.verifyRuntime(output)).verified, true)
```

Also mutate `src/work-controller.mjs` inside the exported artifact and require `verifyRuntime()` to reject with a runtime drift/hash error.

- [ ] **Step 2: Run RED**

Run:

```text
node --test test/runtime-package.test.mjs
```

Expected: fail because `export-runtime.mjs` / `verify-runtime.mjs` do not exist.

- [ ] **Step 3: Implement the runtime exporter and verifier**

`runtimeFiles` is the union of the provider source/runtime files needed by the full server plus these coordinator modules:

```text
src/server.mjs
src/work-ledger.mjs
src/work-controller.mjs
src/work-cli.mjs
src/memory-pool.mjs
test/work-ledger.test.mjs
test/work-controller.test.mjs
test/work-cli.test.mjs
test/memory-pool.test.mjs
test/server.test.mjs
```

Implementation rules:

```js
export async function exportRuntime(destination) {
  // require a new empty directory
  // copy runtimeFiles + package metadata + LICENSE/README
  // compute normalized per-file hashes
  // write PROVENANCE.json with source: 'conversation-sidecar full agent runtime export'
}

export async function verifyRuntime(directory) {
  // verify every PROVENANCE.json file hash
  // verify aggregate sourceContentHash
  // return { verified, sourceRevision, sourceDirty, sourceContentHash, fileCount }
}
```

Do not import or re-export `verifyProvider()` as the runtime verifier; both artifacts keep independent provenance manifests even though they may share `normalizedSha256()` / `aggregateHashes()` helpers.

- [ ] **Step 4: Add package scripts**

Add:

```json
"build:runtime": "node scripts/export-runtime.mjs",
"verify:runtime": "node scripts/verify-runtime.mjs dist/agent-runtime"
```

- [ ] **Step 5: Run GREEN and provider non-regression**

Run:

```text
node --test test/runtime-package.test.mjs test/provider-package.test.mjs
```

Expected: both artifacts pass and provider-package still proves controller/memory are absent from the provider artifact.

- [ ] **Step 6: Commit**

```text
git add scripts/export-runtime.mjs scripts/verify-runtime.mjs test/runtime-package.test.mjs package.json
git commit -m feat:add-full-agent-runtime-artifact
```

---

### Task 2: Introduce Runtime Home config and one stable data root

**Files:**
- Create: `src/runtime-home.mjs`
- Create: `test/runtime-home.test.mjs`
- Modify: `src/server.mjs`

**Interfaces:**
- Produces:

```js
resolveDefaultRuntimeHome({ platform, homeDirectory, localAppData, xdgDataHome })
validateRuntimeConfig(config, runtimeHome)
loadRuntimeConfig(runtimeHome)
resolveRuntimePaths(runtimeHome)
```

- `resolveRuntimePaths(runtimeHome)` returns exact absolute paths for `runtime.json`, `releases`, `bin`, `data`, `conversations`, `works`, `memory`, `migrations`.
- `src/server.mjs` consumes `SIDECAR_DATA_ROOT` and `SIDECAR_MANAGED_PROJECT_URL`.

- [ ] **Step 1: Write RED tests for Windows/Linux default roots and config containment**

Required assertions:

```js
assert.equal(
  resolveDefaultRuntimeHome({ platform: 'linux', homeDirectory: '/home/ad' }),
  '/home/ad/.local/share/conversation-sidecar'
)
assert.equal(
  resolveDefaultRuntimeHome({ platform: 'win32', localAppData: 'C:\\Users\\14579\\AppData\\Local' }),
  'C:\\Users\\14579\\AppData\\Local\\Conversation Sidecar'
)
```

Validate `state` is only `prepared|ready`, release SHA is 40 lowercase hex chars, `current_release_dir` is exactly `<runtime-home>/releases/<sha>`, data root is exactly `<runtime-home>/data`, and ready state requires canonical `managed_project.url`.

- [ ] **Step 2: Run RED**

```text
node --test test/runtime-home.test.mjs
```

- [ ] **Step 3: Implement Runtime Home helpers**

Use `path.win32` for Windows fixtures and `path.posix` for Linux fixtures. Do not inspect `process.platform` inside policy validation; accept `platform` as an injectable boundary.

- [ ] **Step 4: Add stable server data-root wiring**

Change `startDefault()` so:

```js
const dataRoot = process.env.SIDECAR_DATA_ROOT
if (dataRoot) {
  ConversationStore(join(dataRoot, 'conversations'))
  WorkLedger(join(dataRoot, 'works'))
  MemoryPool({ rootDir: join(dataRoot, 'memory'), workLedger })
} else {
  // preserve current development defaults and SIDECAR_DATA_DIR legacy conversation override
}
```

- [ ] **Step 5: Add server tests**

Create a temp data root, construct/start the default wiring through an exported helper such as:

```js
export function createRuntimeComponents({ bridge, dataRoot, legacyConversationRoot, managedProjectUrl })
```

and assert all three stores use sibling directories under one root.

- [ ] **Step 6: Run GREEN + full store/controller/memory tests**

```text
node --test test/runtime-home.test.mjs test/server.test.mjs test/store.test.mjs test/work-ledger.test.mjs test/work-controller.test.mjs test/memory-pool.test.mjs
```

- [ ] **Step 7: Commit**

```text
git add src/runtime-home.mjs src/server.mjs test/runtime-home.test.mjs test/server.test.mjs
git commit -m feat:add-stable-agent-runtime-data-root
```

---

### Task 3: Make `subagents` placement a WorkController invariant

**Files:**
- Modify: `src/work-controller.mjs`
- Modify: `src/server.mjs`
- Modify: `test/work-controller.test.mjs`
- Modify: `test/server.test.mjs`

**Interfaces:**
- `WorkController` constructor becomes:

```js
new WorkController({ ledger, conversationHost, managedProjectUrl, now, minDispatchIntervalMs })
```

- `managedProjectUrl` is either a canonical ChatGPT Project home URL or null.
- Managed dispatch with null rejects with an error whose code is `MANAGED_PROJECT_UNRESOLVED`.

- [ ] **Step 1: Add RED tests**

Add one test proving:

```js
const controller = new WorkController({ ledger, conversationHost: host, managedProjectUrl: projectUrl })
await controller.dispatch('work_test', 'f1')
assert.deepEqual(host.created, [{ projectUrl }])
```

Add one test proving unresolved identity rejects before `host.create()` and `host.created.length === 0`.

- [ ] **Step 2: Run RED**

```text
node --test test/work-controller.test.mjs
```

- [ ] **Step 3: Implement minimal placement enforcement**

Validate canonical URL once in the constructor or shared normalizer; in `#dispatch()` replace:

```js
this.conversationHost.create({})
```

with:

```js
if (!this.managedProjectUrl) {
  const error = new Error('managed_project_unresolved')
  error.code = 'MANAGED_PROJECT_UNRESOLVED'
  throw error
}
this.conversationHost.create({ projectUrl: this.managedProjectUrl })
```

- [ ] **Step 4: Wire server construction**

`createRuntimeComponents()` passes `process.env.SIDECAR_MANAGED_PROJECT_URL ?? null` into WorkController. Manual `conversation_create` remains unchanged.

- [ ] **Step 5: Run GREEN and pacing/dependency regression tests**

```text
node --test test/work-controller.test.mjs test/server.test.mjs
```

- [ ] **Step 6: Commit**

```text
git add src/work-controller.mjs src/server.mjs test/work-controller.test.mjs test/server.test.mjs
git commit -m feat:enforce-subagents-managed-worker-placement
```

---

### Task 4: Add stable Runtime Home launchers and Runtime-Home Native Host registration

**Files:**
- Create: `install/runtime-launcher.mjs`
- Create: `install/runtime-templates/native-host.mjs`
- Create: `install/runtime-templates/conversation-cli.mjs`
- Create: `install/runtime-templates/work-cli.mjs`
- Create: `install/runtime-templates/conversation-sidecar-host`
- Create: `install/runtime-templates/conversation-sidecar-host.bat`
- Create: `install/runtime-templates/chatgpt-conversation`
- Create: `install/runtime-templates/chatgpt-conversation.cmd`
- Create: `install/runtime-templates/conversation-work`
- Create: `install/runtime-templates/conversation-work.cmd`
- Create: `test/runtime-launcher.test.mjs`
- Modify: `install/install-host.mjs`

**Interfaces:**
- `installRuntimeLaunchers({ runtimeHome, platform })` installs/updates stable `bin/` files.
- `runtimeLauncherEnvironment(config)` returns `SIDECAR_DATA_ROOT` and optional `SIDECAR_MANAGED_PROJECT_URL`.
- `installNativeHost()` gains an explicit `hostPath` path supplied by bootstrap, so registered manifests point at Runtime Home `bin/conversation-sidecar-host(.bat)`.

- [ ] **Step 1: Add RED tests**

Verify a prepared config launches `src/server.mjs` with data root but without managed-project env. Verify a ready config adds `SIDECAR_MANAGED_PROJECT_URL`. Verify launchers reject a release path outside `<runtime-home>/releases/`.

- [ ] **Step 2: Run RED**

```text
node --test test/runtime-launcher.test.mjs
```

- [ ] **Step 3: Implement JS launchers and thin shell/cmd wrappers**

No release SHA may be embedded into the wrappers. All release selection comes from `runtime.json`.

- [ ] **Step 4: Run GREEN plus native-host contracts**

```text
node --test test/runtime-launcher.test.mjs test/native-host-installer.test.mjs test/windows-runtime.test.mjs
```

- [ ] **Step 5: Commit**

```text
git add install/runtime-launcher.mjs install/runtime-templates install/install-host.mjs test/runtime-launcher.test.mjs test/native-host-installer.test.mjs test/windows-runtime.test.mjs
git commit -m feat:add-stable-runtime-home-launchers
```

---

### Task 5: Implement idempotent bootstrap prepare/activate/migrate/project-resolution flow

**Files:**
- Create: `scripts/bootstrap-runtime.mjs`
- Create: `test/bootstrap-runtime.test.mjs`
- Modify: `package.json`
- Modify: `skills/chatgpt-subagents/SKILL.md`

**Interfaces:**
- Export:

```js
parseBootstrapArgs(argv)
bootstrapRuntime(options)
```

- Supported V1 flags are exactly:

```text
--runtime-home <absolute-path>
--managed-project-url <canonical-url>
--migrate-data-from <absolute-path>
--activate
--json
--live-check
```

- Result has `{ ok, state, runtimeHome, sourceRevision, currentRelease, managedProject, activation, checks, error? }`.

- [ ] **Step 1: Add RED argument/preflight/idempotence tests**

Required cases:

```text
relative --runtime-home rejected
unknown flag rejected
same source SHA reused rather than duplicated
existing mismatched releases/<sha> rejected
external active registration preserved without --activate
```

- [ ] **Step 2: Add RED migration-authority tests**

Model legacy roots using temp directories. Require:

```text
explicit --migrate-data-from wins
active-registration-derived non-empty data wins over checkout-local data
multiple distinct non-empty candidates without explicit authority -> data_root_conflict
migration copies bytes and never removes source
```

- [ ] **Step 3: Add RED two-stage Project tests**

Require fresh bootstrap to reach `prepared` before extension trust/project resolution. Resolution order:

```text
existing ready runtime config
migrated legacy defaultProjectUrl
explicit --managed-project-url
live project_find('subagents')
```

When unresolved, return `extension_trust_required` or `managed_project_unresolved` without creating a duplicate Project. When resolved, atomically write `state: ready`.

- [ ] **Step 4: Implement bootstrap phases 1-8**

Use temporary staging directories and atomic rename for releases/config. Do not kill active processes. Do not change an external registration unless `--activate`.

- [ ] **Step 5: Add package script and Skill update**

```json
"bootstrap": "node scripts/bootstrap-runtime.mjs"
```

Skill setup becomes Runtime-Home based and explicitly states managed workers always use configured `subagents` Project.

- [ ] **Step 6: Run focused GREEN**

```text
node --test test/bootstrap-runtime.test.mjs test/runtime-home.test.mjs test/runtime-launcher.test.mjs test/runtime-package.test.mjs test/work-controller.test.mjs
```

- [ ] **Step 7: Commit**

```text
git add scripts/bootstrap-runtime.mjs test/bootstrap-runtime.test.mjs package.json skills/chatgpt-subagents/SKILL.md
git commit -m feat:add-idempotent-agent-runtime-bootstrap
```

---

### Task 6: Add bounded live-check and complete cross-platform release gates

**Files:**
- Modify: `scripts/bootstrap-runtime.mjs`
- Modify: `test/bootstrap-runtime.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-06-agent-runtime-bootstrap-design.md` only if execution evidence requires a factual correction.

**Interfaces:**
- `--live-check` runs exactly one managed worker canary plus one memory retrieval canary.

- [ ] **Step 1: Add RED live-check orchestration test with fakes**

Assert the sequence:

```text
work_create RUNTIME_LIVE_CHECK
SPLIT one frontier
work_dispatch -> conversation created with managedProjectUrl
collect exact turn
STOP + completed
memory_publish
second work_create
memory_query contains canary outcome
memory_read
second work ledger contains memory_consumed
```

- [ ] **Step 2: Implement minimal live-check**

No canary cleanup/deletion API is added. Results remain auditable under the stable data root.

- [ ] **Step 3: Run full Windows suite and integrity gates**

```text
npm test
npm run extension:check
git diff --check
```

- [ ] **Step 4: Bootstrap a disposable Windows Runtime Home**

Use `--runtime-home` under a disposable directory, verify release/config/data/launcher/native-host manifest generation without replacing the known-good active registration unless explicitly performing the authorized live gate.

- [ ] **Step 5: Run the same candidate SHA on Linux**

Create/reuse an isolated Linux worktree, run full suite, build/verify runtime artifact, bootstrap a disposable Runtime Home and compare runtime provenance/source content hash with Windows.

- [ ] **Step 6: Run one authorized real `--live-check`**

Require proof that the managed conversation canonical URL belongs to the configured `subagents` Project and memory is consumed by the second work.

- [ ] **Step 7: Final verification and commit any factual doc corrections**

Do not create a verification-only code commit. If no source changes remain, leave the branch clean and report the exact release-candidate SHA.

---

### Task 7: Install user command shims and the managed `chatgpt-subagents` Skill

**Files:**
- Create: `install/runtime-user-install.mjs`
- Create: `test/runtime-user-install.test.mjs`
- Modify: `scripts/bootstrap-runtime.mjs`
- Modify: `test/bootstrap-runtime.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-06-agent-runtime-bootstrap-design.md` only if execution evidence requires a factual correction.

**Interfaces:**
- `resolveUserInstallPaths({ platform, homeDirectory, roamingAppData })` returns a user command directory and `~/.agents/skills/chatgpt-subagents` discovery path.
- `installRuntimeUserEntrypoints({ runtimeHome, releaseDir, platform, homeDirectory, roamingAppData })` installs managed command shims and the verified release Skill idempotently.
- Linux commands are installed under `~/.local/bin`; Windows commands are installed under `%APPDATA%\\npm` so existing npm-style PATH discovery can resolve them.
- Foreign command files are never overwritten. Only shims marked as conversation-sidecar managed files may be updated.

- [ ] **Step 1: Add RED path/idempotence/conflict tests**

Require Linux and Windows path semantics, command shims that reference Runtime Home but no release SHA, exact Skill copy from the verified release, idempotent rerun, and fail-closed behavior on a foreign existing command.

- [ ] **Step 2: Implement minimal user install surface**

Install only `chatgpt-conversation`, `conversation-work`, and `chatgpt-subagents/SKILL.md`. Do not add global package managers, sudo requirements, symlink privileges, PowerShell profile edits, or shell-rc mutation.

- [ ] **Step 3: Wire user install into bootstrap**

Bootstrap executes the user install after stable Runtime Home launchers exist. Result checks report command/Skill installation and whether the chosen command directory is already present on PATH; PATH absence is a deterministic hint, not a silent mutation.

- [ ] **Step 4: Run focused GREEN**

```text
node --test test/runtime-user-install.test.mjs test/bootstrap-runtime.test.mjs test/runtime-launcher.test.mjs
```

- [ ] **Step 5: Re-run Windows and Linux full suites plus one Runtime Home live-check on the final SHA**

The final live-check must still prove the child conversation was created in the canonical `subagents` Project and memory was consumed by the second Work.

- [ ] **Step 6: Commit**

```text
git add install/runtime-user-install.mjs test/runtime-user-install.test.mjs scripts/bootstrap-runtime.mjs test/bootstrap-runtime.test.mjs docs/superpowers/specs/2026-09-06-agent-runtime-bootstrap-design.md docs/superpowers/plans/2026-09-06-agent-runtime-bootstrap.md
git commit -m feat:install-agent-runtime-user-entrypoints
```
