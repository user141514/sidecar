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
- local mymem repository path, overridden by `SIDECAR_MYMEM_REPO` when set and otherwise defaulting to sibling `../mymem` next to the Sidecar checkout;
- retry delay;
- injectable uploader runner/timer/logger for tests.

Behavior:
1. `kick()` is fire-and-forget and never waits for upload completion.
2. Before uploading, validate local mymem availability: Git repository exists, `origin` canonicalizes to `github.com/user141514/mymem`, uploader script exists.
3. If unavailable or wrong repository, disable that pass without affecting MemoryPool or task completion.
4. Only one uploader run may execute at a time.
5. A kick received while one run is active is coalesced into exactly one follow-up pass.
6. Upload failure schedules a delayed retry; retry state is transient because durable pending state remains derivable from Local MemoryPool versus online mymem.
7. A successful/no-op uploader run clears retry need.

## Triggers

- After every successful `MemoryPool.publish()` call, including idempotent repair/backfill, Sidecar calls `bridge.kick()` after local durability has been established.
- After Sidecar has started listening, it calls `bridge.kick()` once to recover a local-memory-to-trigger crash window.

Neither trigger is a correctness boundary. Losing a trigger cannot lose the local memory record; startup/retry or a later publish re-runs reconciliation.

## Completion semantics

`work_append(type=completed)` still awaits only WorkLedger terminal append plus Local MemoryPool durability. It MUST NOT await `MemorySyncBridge`, Git, SSH, GitHub, or online readback.

## V0 acceptance

1. Valid local mymem + pending memory can be uploaded by the existing uploader.
2. Missing/wrong local mymem does not fail task completion.
3. Concurrent kicks never run multiple uploaders simultaneously and coalesce to a follow-up pass.
4. Upload failure leads to a delayed retry without deleting local intent.
5. Startup kicks once.
6. A successful MemoryPool publish kicks once after local durability.
7. Live terminal completion returns before a deliberately delayed online sync finishes, and the resulting exact MemoryRecordKey later appears on fetched GitHub main.

## Non-goals

No filesystem watcher, system daemon, persistent retry queue, periodic global scheduler, memory ranking, project-summary promotion, or new authentication architecture in V0.
