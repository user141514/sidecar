# Portable Agent Runtime Bootstrap Design

## Status

Approved architecture: **B — stable Runtime Home + immutable releases + one bootstrap**.

This design turns the existing conversation-sidecar scheduler/memory stack into a portable local Agent Runtime. It does **not** extract the Orca/orca-sub orchestration protocol in this phase. Orca remains an optional future backend/adapter.

## Development authority

The authoritative Windows integration workspace is:

```text
C:/Users/14579/.devspace/worktrees/multi-conversation-eefbbb6b
branch: stabilize/unified-mainline-20260906
```

All Windows-side integration work for Runtime Home, managed `subagents` workers, WorkController, MemoryPool, bootstrap, and shared conversation protocol must originate from this workspace/branch. Linux worktrees are parity and live-gate environments only; legacy Windows branches, rollback worktrees, archived checkouts, and machine-local running packages are evidence or deployment targets, not source authority.

A dedicated Git baseline ref records the immutable starting point for this integration line; the branch itself remains the evolving Windows integration authority.

## Goal

A Windows or Linux machine with the repository and Node.js 24+ should be able to prepare or update the local Agent Runtime with one command from the desired source checkout:

```text
npm run bootstrap
```

After Chrome's unavoidable one-time unpacked-extension trust action, the same bootstrap command becomes idempotent and should converge the machine to a known runtime release without requiring the operator to manually reason about Git worktrees, Native Messaging manifests, data directories, Project pinning, WorkController wiring, MemoryPool wiring, or skills.

Managed child conversations must always be created inside the canonical ChatGPT **`subagents` Project**. The runtime must refuse managed dispatch when that Project identity is unresolved; falling back to root `https://chatgpt.com/` is not allowed for WorkController workers.

## Non-goals

This phase does not:

- extract or replace the Orca/orca-sub Run/Task/Dispatch/worker_done protocol;
- add recursive worker delegation;
- add a background service manager, systemd unit, or Windows Service;
- publish the package to npm;
- introduce a vector database, embedding memory, or learned memory router;
- remove the one-time Chrome "Load unpacked" trust boundary;
- auto-delete old releases or legacy source data;
- silently merge two divergent historical data roots.

## Core invariants

1. **Source != installation.** A Git checkout is source material only. Native Messaging, CLI entrypoints, and persistent state must not point directly at an arbitrary development checkout after bootstrap.
2. **Installation != data.** Releases are immutable and replaceable. Conversations, Work Ledgers, and MemoryPool records live under a stable machine Runtime Home and survive release changes.
3. **OS != application behavior.** Conversation protocol, WorkController, WorkLedger, MemoryPool, Project placement, CLI semantics, and skills remain shared. OS-specific behavior is limited to filesystem paths and shell/native-host launch adapters.
4. **Managed worker placement is explicit.** WorkController dispatch must consume a resolved canonical `managedProjectUrl`. Missing identity is a hard error, never a root-chat fallback.
5. **Release activation is atomic at the configuration boundary.** A release becomes current only after export, provenance verification, runtime checks, and configuration write succeed.
6. **Existing working installations are not silently replaced.** If bootstrap detects an active Native Messaging registration outside Runtime Home, it prepares the new runtime but requires explicit `--activate` before switching authority.
7. **Legacy data is never destroyed.** First migration copies legacy data into Runtime Home and records provenance. Source data remains untouched.
8. **Ambiguous data migration fails closed.** If Runtime Home already contains data and a second distinct legacy root is discovered, bootstrap reports `data_root_conflict`; it does not auto-merge histories.
9. **One machine has one runtime authority.** Runtime Home configuration identifies exactly one current release and one stable data root.
10. **Bootstrap is idempotent.** Re-running it against the same source SHA and same config produces no duplicate release, no duplicate Project creation, and no data rewrite.

## Runtime Home

Default root:

```text
Linux:   ${XDG_DATA_HOME:-~/.local/share}/conversation-sidecar
Windows: %LOCALAPPDATA%\Conversation Sidecar
```

Layout:

```text
<runtime-home>/
  runtime.json
  releases/
    <git-sha>/
      PROVENANCE.json
      package.json
      extension/
      install/
      scripts/
      skills/
      src/
      ...standalone provider files...
  bin/
    native-host.mjs
    conversation-cli.mjs
    work-cli.mjs
    conversation-sidecar-host        # POSIX shim
    conversation-sidecar-host.bat    # Windows shim
    chatgpt-conversation             # POSIX shim
    chatgpt-conversation.cmd         # Windows shim
    conversation-work                # POSIX shim
    conversation-work.cmd            # Windows shim
  data/
    conversations/
    works/
    memory/
  migrations/
    <timestamp>-legacy-data.json
```

Do not rely on a `current` symlink. Windows symlink/junction behavior and permissions are unnecessary complexity. `runtime.json` is the cross-platform authority for the current release.

## Runtime configuration

`runtime.json` schema version 1 supports a deliberate two-stage lifecycle:

```json
{
  "schema_version": 1,
  "state": "prepared",
  "current_release": "<40-char-git-sha>",
  "current_release_dir": "<absolute-runtime-home>/releases/<sha>",
  "data_root": "<absolute-runtime-home>/data",
  "managed_project": null,
  "extension": {
    "id": "cfifihieaffhniimpimnfmignbbdaalb"
  }
}
```

After `subagents` identity is resolved, bootstrap atomically promotes only the readiness fields:

```json
{
  "state": "ready",
  "managed_project": {
    "name": "subagents",
    "url": "https://chatgpt.com/g/g-p-.../project"
  }
}
```

`prepared` is a valid installation state: the release, stable data root, launchers, and Native Messaging link may exist, but managed worker dispatch is disabled. This closes the fresh-machine bootstrap cycle where the live extension must connect to the installed Native Host before `project_find subagents` can succeed.

The bootstrap implementation derives `current_release_dir` itself; user input never supplies arbitrary release paths.

## Stable launchers

The Native Messaging manifest must point to the Runtime Home stable launcher, not a release directory and not a Git checkout.

`bin/native-host.mjs`:

1. reads and validates `runtime.json`;
2. resolves `<current_release_dir>/src/server.mjs` under `releases/`;
3. sets `SIDECAR_DATA_ROOT=<runtime-home>/data`;
4. when `managed_project.url` is resolved, sets `SIDECAR_MANAGED_PROJECT_URL=<canonical subagents URL>`; otherwise leaves it unset;
5. spawns the current release server with inherited stdin/stdout/stderr;
6. mirrors the child exit code.

A `prepared` runtime may therefore expose conversation transport and project-discovery tools, but WorkController dispatch must fail closed until the configuration reaches `ready`.

The platform shell wrappers only locate Node and invoke `native-host.mjs`. They contain no product logic.

`bin/conversation-cli.mjs` and `bin/work-cli.mjs` similarly read `runtime.json` and delegate to the current release's `src/cli.mjs` and `src/work-cli.mjs`. This makes release switching independent from `npm link`.

## Stable data root

The server gains one shared runtime option:

```text
SIDECAR_DATA_ROOT=<absolute-root>
```

When set:

```text
ConversationStore -> <root>/conversations
WorkLedger        -> <root>/works
MemoryPool        -> <root>/memory
```

Backward compatibility:

- `SIDECAR_DATA_DIR` remains accepted only as the legacy conversation-store override when `SIDECAR_DATA_ROOT` is absent.
- Without either environment variable, direct development execution retains the current checkout-local defaults.

Bootstrap always launches through `SIDECAR_DATA_ROOT`, so installed runtime state is never checkout-local.

## Managed `subagents` Project

The canonical historical Project identity already observed in the existing installation is:

```text
https://chatgpt.com/g/g-p-6a983ccfa9148191b42da3db5412f946/project
```

The implementation must not hard-code that account-specific URL as a universal constant. Bootstrap resolves Project identity in this order:

1. existing valid `runtime.json.managed_project.url`;
2. migrated legacy `data/conversations/config.json.defaultProjectUrl`, if canonical;
3. `project_find subagents` through the live extension;
4. if still unresolved, report `managed_project_unresolved` and require either:
   - the user to open the existing `subagents` Project once and re-run bootstrap, or
   - an explicit `--managed-project-url <canonical-url>`.

Bootstrap must **not automatically create another `subagents` Project** merely because discovery could not see an existing Project. Duplicate Project creation is worse than a one-time explicit resolution gate.

After resolution, bootstrap persists the canonical URL to Runtime Home config.

### WorkController enforcement

`WorkController` receives `managedProjectUrl` at construction.

For managed dispatch:

```text
conversationHost.create({ projectUrl: managedProjectUrl })
```

If `managedProjectUrl` is absent or invalid:

```text
managed_project_unresolved
```

and no browser conversation is created.

This is independent of the ordinary ConversationStore default Project. Manual/non-worker conversations retain their existing behavior.

## Bootstrap command

Repository script:

```text
npm run bootstrap
```

backed by:

```text
scripts/bootstrap-runtime.mjs
```

Supported options in V1:

```text
--runtime-home <absolute-path>      # testing/advanced override
--managed-project-url <url>        # explicit canonical identity
--migrate-data-from <absolute-path># explicit legacy data authority when discovery is ambiguous
--activate                         # switch an existing external registration
--json                             # machine-readable result
--live-check                       # bounded real worker/memory canary after activation
```

No interactive wizard is required. Human-readable output is the default; `--json` is deterministic.

## Bootstrap phases

### Phase 1 — Preflight

Validate:

- Node.js >= 24;
- source checkout is Git-backed;
- exact source SHA;
- extension build metadata is current;
- runtime-home paths are absolute and writable;
- source is not inside runtime-home `releases/`.

### Phase 2 — Build immutable Agent Runtime release

The existing standalone **provider** artifact is intentionally transport-only and must remain so. Its tests explicitly require `src/work-controller.mjs`, `src/memory-pool.mjs`, and `data/` to be absent. Runtime bootstrap therefore must **not** install `build:provider` as the Agent Runtime.

Add a separate full-runtime artifact surface:

```text
scripts/export-runtime.mjs
scripts/verify-runtime.mjs
npm run build:runtime
npm run verify:runtime
```

The runtime artifact contains the shared provider files plus the coordinator/runtime-owned modules required to execute scheduler and memory behavior, including at minimum:

```text
src/server.mjs
src/work-ledger.mjs
src/work-controller.mjs
src/work-cli.mjs
src/memory-pool.mjs
```

and all shared conversation/extension/install modules needed by `src/server.mjs`. It must not contain checkout-local `data/` or `.git`.

Export first to a temporary sibling directory:

```text
releases/.staging-<sha>-<uuid>
```

The runtime verifier uses the same normalized hashing/provenance principles as the existing provider verifier but has an independent runtime file manifest. Require:

```text
sourceRevision == current source HEAD
sourceDirty == false for runtime-owned files
verified == true
```

Provider and Runtime artifacts remain separate products:

```text
provider artifact = conversation transport distribution
runtime artifact  = provider + WorkController + WorkLedger + MemoryPool
```

If `releases/<sha>` already exists, verify it with `verify-runtime` and reuse it only when the content hash matches. A mismatching existing directory is an integrity error.

Rename staging to `releases/<sha>` only after runtime verification.

### Phase 3 — Install stable launchers

Create/update Runtime Home `bin/` launchers from versioned templates in the repository. Launcher writes are atomic via temporary file + rename where supported.

No release-specific path is embedded in Native Messaging manifests or user PATH shims.

### Phase 4 — Data migration

If Runtime Home data is empty, discover legacy data roots with an explicit authority order:

1. `--migrate-data-from`, when supplied;
2. the data root derivable from the currently active Native Messaging registration / launcher;
3. the current source checkout's legacy `data/`, only when no higher-authority non-empty root exists.

A legacy root is eligible only when it contains recognized `conversations/`, `works/`, or `memory/` structures.

Rules:

- copy, never move;
- preserve JSON/JSONL bytes;
- record source path, authority source, timestamp, counts, and copied directory names under `migrations/`;
- never delete the legacy source;
- if Runtime Home is non-empty, do not automatically merge a second root;
- if two distinct non-empty candidate roots are discovered and neither is explicitly selected, fail with `data_root_conflict` rather than guessing or merging.

This prevents a development/canary worktree's checkout-local `data/` from silently overriding the machine's actual historical runtime data. The selected legacy root's historical `defaultProjectUrl` may be imported during this phase.

### Phase 5 — Write prepared runtime config

Write `runtime.json` with `state: prepared`, the verified release, and stable data root. Preserve an already-validated managed Project URL during upgrades; otherwise `managed_project` is null.

Validate the prepared config through the stable launcher library, then atomically replace `runtime.json`. On an upgrade of an existing ready Runtime Home, do not change `current_release` until the new release passes the pre-activation checks required by this spec.

### Phase 6 — Native Messaging registration / activation

If no existing registration is present, install the manifest pointing at the Runtime Home stable launcher. This allows the signed-in extension to connect to the prepared runtime so Project discovery can occur.

If an existing registration points outside Runtime Home:

- without `--activate`: preserve it and return `prepared_not_activated` unless managed Project identity can be recovered from legacy config or the existing live runtime;
- with `--activate`: update the manifest to Runtime Home stable launcher and report that one extension/native-host reconnect may be required.

Do not kill arbitrary processes during bootstrap V1.

### Phase 7 — Resolve managed Project and promote readiness

Resolve `subagents` Project identity using the order above. If the extension has not yet been manually trusted/loaded on a fresh machine, return a prepared result that identifies the exact release `extension/` directory and asks the user to perform the one unavoidable Chrome trust action, then re-run the same bootstrap command.

When resolution succeeds, atomically update `runtime.json` to `state: ready` with the canonical Project URL. No managed worker dispatch is enabled before this transition.

### Phase 8 — Deterministic self-check

Always verify without creating a GPT turn:

```text
runtime config              OK
release provenance          OK
stable launchers            OK
native-host manifest        OK / PREPARED
stable data root            OK
managed subagents project   OK
WorkController construction OK
MemoryPool construction     OK
```

If the extension supports `extension_status`, include build/instance health. Missing status on an older active installation is reported as `legacy_runtime`, not as source failure.

### Phase 9 — Optional live check

`--live-check` is explicitly opt-in because it creates a real ChatGPT turn.

It must:

1. create one Work Ledger canary;
2. create one frontier;
3. dispatch through WorkController, proving the resulting conversation canonical URL is inside the configured `subagents` Project;
4. collect exact-turn completion;
5. STOP + append completed;
6. publish one memory;
7. create a second canary Work;
8. query/read the memory and verify `memory_consumed`;
9. label all canary goals/results with `RUNTIME_LIVE_CHECK` so they are distinguishable from user work.

V1 does not add deletion APIs solely to erase canary evidence. The check is opt-in and auditable.

## Upgrade model

Running bootstrap from a newer clean source checkout performs an upgrade:

```text
source checkout
  -> export releases/<new-sha>
  -> verify
  -> keep stable data root
  -> keep managed Project URL
  -> atomically set runtime.json.current_release
```

Old releases remain available for rollback. No automatic pruning in V1.

The Native Messaging manifest normally remains unchanged because it already points at the Runtime Home stable launcher.

## Rollback model

Rollback changes only `runtime.json.current_release` and `current_release_dir` to a previously verified release SHA. Stable data is never rewound automatically.

A rollback target must:

- exist under `releases/`;
- have valid `PROVENANCE.json`;
- satisfy compatible runtime config schema;
- pass launcher preflight.

If a newer release performed an incompatible persistent-data migration, rollback must refuse unless an explicit compatible migration path exists. V1 introduces no destructive data migrations, so current data schema remains backward-compatible.

## Failure behavior

Bootstrap failures are classified and leave the prior runtime authority intact whenever possible:

```text
preflight_failed
release_integrity_failed
data_root_conflict
managed_project_unresolved
extension_trust_required
activation_required
native_host_registration_failed
self_check_failed
live_check_failed
```

The command reports the phase, exact error, runtime-home path, source SHA, and whether the active installation was changed.

No failure path deletes a release, legacy data, or existing Native Messaging manifest automatically.

## CLI / Skill installation

The Runtime Home stable shims replace `npm link` as installation authority.

Bootstrap may add `<runtime-home>/bin` to a user-scoped PATH only when the platform has a deterministic, reversible user-level mechanism. Otherwise it prints the one path to add and continues; Native Messaging does not depend on PATH.

The `chatgpt-subagents` skill shipped inside a release is copied/linked into the normal agent skill discovery location by bootstrap through an idempotent install step. Skill content describes Runtime Home commands rather than Git checkout paths.

A future separate skill may expose the higher-level Agent Runtime protocol after Orca extraction; that is not part of V1.

## Platform boundary

Shared:

```text
scripts/bootstrap-runtime.mjs core flow
runtime config schema
release verification
legacy-data discovery/migration
managed Project resolution
WorkController placement policy
stable launcher JS logic
self-check/live-check semantics
```

Platform adapters only:

```text
runtime-home default path
POSIX shell shim vs Windows .cmd shim
Native Messaging registration path/registry semantics
optional user PATH integration
```

No `win32`/`linux` branch is permitted in WorkController, MemoryPool, ConversationStore, project placement logic, or bootstrap phase ordering.

## Verification requirements

### Unit / integration

- runtime-home path resolution on Linux and Windows;
- runtime.json schema validation and path containment;
- runtime artifact includes WorkController/WorkLedger/MemoryPool while provider artifact remains transport-only;
- runtime/provider provenance manifests remain independently verifiable;
- immutable runtime release reuse vs hash mismatch;
- legacy data copy without source mutation;
- non-empty destination conflict fails closed;
- active-registration-derived data outranks checkout-local canary data;
- multiple non-empty legacy roots require explicit authority;
- prepared runtime can start transport while managed dispatch remains disabled;
- managed project resolution order;
- WorkController refuses dispatch without project identity;
- WorkController passes exact project URL to `conversationHost.create`;
- stable launcher resolves current release and data root;
- existing external Native Messaging registration is preserved without `--activate`;
- bootstrap rerun is idempotent;
- existing full repository suite remains green.

### Real Windows and Linux gates

Use the same candidate SHA on both hosts.

Each host must prove:

```text
bootstrap prepare
runtime-home release provenance
stable data root
subagents Project resolution
native-host registration contract
```

At least one host must run `--live-check` end-to-end before promotion. Before final release, both hosts should run the live gate when a disposable/authorized browser installation is available.

## Success criteria

V1 is complete when:

1. a clean source checkout can run one bootstrap command to produce a verified **full Agent Runtime** Home, not merely the transport-only provider artifact;
2. installed Native Messaging and CLI paths no longer point directly at a Git checkout;
3. conversations, works, and memory survive changing release SHA and checkout path;
4. managed dispatch cannot create outside the configured `subagents` Project;
5. re-running bootstrap is idempotent;
6. an existing external working registration is not replaced without `--activate`;
7. Windows and Linux pass the same source/runtime-home test suite;
8. one real live-check proves `subagents` worker dispatch -> exact-turn collect -> memory publish/query/read/consume.
