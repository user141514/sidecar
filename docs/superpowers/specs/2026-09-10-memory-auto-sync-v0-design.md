# Memory Auto Sync V0 Design

Status: approved for implementation
Date: 2026-09-10

## Goal

After a Sidecar MemoryPool record is durably committed, opportunistically synchronize local MemoryPool state into a local `mymem` checkout without making task completion depend on GitHub or network availability.

## Authority and scope

- Local MemoryPool remains the task-completion durability boundary.
- `mymem/main` is the online convergence target.
- A host participates only when it has a valid local mymem checkout whose `origin` identifies `github.com/user141514/mymem` and whose `scripts/upload-local-memory.mjs` exists.
- Ordinary Git credentials of that checkout are sufficient. No deploy-key-only authority, host registry, PR verifier, or signing/provenance admission layer is part of V0.
- Existing `mymem/scripts/upload-local-memory.mjs` owns record validation, pending derivation, non-force publication, remote-advanced rejection, and exact MemoryRecordKey readback.

## Bridge

Sidecar adds one small `MemorySyncBridge`.

Inputs:
- local MemoryPool root;
- preferred local mymem path: `SIDECAR_MYMEM_REPO` when set, otherwise sibling `../mymem` next to the Sidecar checkout;
- platform-appropriate machine search roots used only when the preferred/cached path is unavailable;
- retry delay;
- injectable discovery/uploader/timer/logger seams for tests.

Behavior:
1. `kick()` is fire-and-forget and never waits for upload completion.
2. Validate the preferred path first. A valid repository must be a Git worktree, have `origin` canonicalizing to `github.com/user141514/mymem`, and contain `scripts/upload-local-memory.mjs`.
3. If the preferred path is invalid, reuse a previously discovered valid path when available; if that cached path has become invalid, invalidate it and rediscover.
4. Machine discovery is broad but admission is strict: scan platform-appropriate user/storage roots for Git repositories, then accept only repositories satisfying the exact remote + uploader contract. `graft` is not a runtime dependency because it requires a known repository root.
5. Discovery runs on startup/first need or after cache invalidation, not on every MemoryPool publish. A negative discovery result remains cached for the process lifetime unless the preferred path later becomes valid or the process restarts.
6. If several valid repositories exist, a `main` checkout is preferred, then the shorter/stable path order is used.
7. If no valid repository is available, disable that pass without affecting MemoryPool or task completion.
8. Only one uploader run may execute at a time.
9. A kick received while one run is active is coalesced into exactly one follow-up pass.
10. Upload failure schedules a delayed retry; retry state is transient because durable pending state remains derivable from Local MemoryPool versus online mymem.
11. A successful/no-op uploader run clears retry need.

## Triggers

- After every successful `MemoryPool.publish()` call, including idempotent repair/backfill, Sidecar calls `bridge.kick()` after local durability has been established.
- After Sidecar has started listening, it calls `bridge.kick()` once to recover a local-memory-to-trigger crash window.

Neither trigger is a correctness boundary. Losing a trigger cannot lose the local memory record; startup/retry or a later publish re-runs reconciliation.

## Completion semantics

`work_append(type=completed)` still awaits only WorkLedger terminal append plus Local MemoryPool durability. It MUST NOT await `MemorySyncBridge`, Git, SSH, GitHub, or online readback.

## V0 acceptance

1. Valid local mymem + pending memory can be uploaded by the existing uploader.
2. If the preferred sibling/configured path is missing, machine discovery can find a deeper/differently named checkout whose exact `origin` and uploader contract match.
3. Wrong-remote repositories are never admitted; explicit valid path remains highest priority.
4. A discovered path is reused without rescanning and is rediscovered after cache invalidation.
5. Windows search roots cover the user home and drive roots without POSIX path assumptions.
6. Missing/wrong local mymem does not fail task completion.
7. Concurrent kicks never run multiple uploaders simultaneously and coalesce to a follow-up pass.
8. Upload failure leads to a delayed retry without deleting local intent.
9. Startup kicks once.
10. A successful MemoryPool publish kicks once after local durability.
11. Live terminal completion returns before a deliberately delayed online sync finishes, and the resulting exact MemoryRecordKey later appears on fetched GitHub main.

## Non-goals

No filesystem watcher, system daemon, persistent retry queue, periodic global scheduler, memory ranking, project-summary promotion, or new authentication architecture in V0.
