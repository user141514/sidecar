---
name: conversation-workers
description: Use for managed ChatGPT child conversations and verified self-updates of the conversation extension from a local shell on Linux or Windows. This creates conversation_worker tasks through Sidecar/WorkController; do not use it for DevSpace local Codex/Claude/Pi host workers or Orca workers.
---

# ChatGPT Conversation Workers

The installed Runtime Home owns conversation transport, WorkController, WorkLedger and MemoryPool. Git checkouts are source inputs only; after bootstrap, Native Messaging, stable CLI entrypoints and persistent data must not point directly at an arbitrary development checkout. Orca/orca-sub is not required for this runtime.

## Setup

Use Node 24 or newer. From the authoritative clean source checkout run `npm run bootstrap`. Bootstrap exports a verified immutable full Agent Runtime release, installs stable Runtime Home launchers, preserves/copies legacy data into one stable data root, and resolves the managed `subagents` Project.

Do **not** use `npm link` or `npm run install:host` as installation authority for a bootstrapped machine. Those commands remain development/legacy surfaces only.

A fresh machine may return `extension_trust_required` with `state: prepared`. Load the exact `extension/` directory reported for that Runtime Home release once in the signed-in Chrome profile, preserving the fixed extension identity, then run the same `npm run bootstrap` command again. Managed worker dispatch stays disabled until the runtime reaches `state: ready` with a canonical `subagents` Project URL.

If bootstrap detects an existing working Native Messaging registration outside Runtime Home, it must not switch it unless the user has authorized `--activate`. Do not bypass that gate by manually rewriting manifests, registry entries, browser profiles or checkout-local launchers.

## Managed conversation workers

Managed coordinator conversation workers use `conversation-work` / the `work_*` MCP tools. Their machine-readable worker kind is `conversation_worker` and backend is `sidecar`. `WorkController.dispatch()` is required to create every managed child inside the canonical `subagents` Project stored in Runtime Home config; missing Project identity is a hard error and must never fall back to root `https://chatgpt.com/`. Do not substitute DevSpace local provider workers (`host_worker`) or Orca workers for this route.

Manual transport remains available through `chatgpt-conversation create [--project <project_url>] [--mode chat|work]`, `send`, and `read`. `create` defaults to Chat; use `--mode work` only when Work is requested. Mode selection must be read back on the opened page before creation returns. Do not use manual root conversations as a substitute for managed worker dispatch.

Thinking strength is a separate control on that opened conversation tab. Honor the requested Chat/Work mode, change strength on the exact returned tab, and read back both mode and strength there. Switching to Work is not part of changing Chat strength; a separate Work test must be identified as such.

`send` acknowledges submission, not completion. Use `chatgpt-conversation read <conversation_id>` later or `conversation-work collect <work_id>` for managed work. Keep conversation and turn IDs; do not substitute tab/window IDs. A repeated `generating` ledger snapshot does not establish either live progress or a fault. Never infer failure from model latency or unchanged visible text alone.

For multi-worker use, preserve the controller's pacing contract. Do not bypass WorkController to burst-create child conversations.

## Verified extension updates

After updating local source through the approved Git workflow, build/test the source and run bootstrap to create or select a new verified Runtime Home release. Extension identity and build metadata travel with that release.

- `chatgpt-conversation extension-status` reports the running extension ID, version, build ID, instance ID, pending/outbox counts and last reload receipt.
- `chatgpt-conversation extension-update` (alias `extension-reload`) applies the staged unpacked extension and independently verifies the reconnect. Optional `--timeout-ms N`, 100–300000, default 30000.

The agent may invoke the verified CLI update when the user has authorized updating this installation. Keep actual browser writers, unresolved content effects and undelivered outbox entries out of the update boundary. Preserve unknown sends as unknown; never replay them or fabricate submission receipts.

When the user explicitly ends an owned manual test, use the existing pending-retirement maintenance API with `closed_manual_owner_after_quiesce`. It requires the exact current attempt and snapshot, the original owned tab closed, real writer/content drains, and empty effects/outbox. Keep the original pending, ledger and mailbox; the independent retirement receipt ends execution ownership without claiming delivery. Watchdog retirement keeps its separate durable registration revocation requirements.

If an older extension lacks that maintenance branch, explicit user-authorized maintenance may stage the verified release and Reload that same extension identity once after those drain checks and a rollback snapshot. Hold the existing maintenance barrier continuously until the old worker unloads; a point-in-time quiescence acknowledgement is not a persistent freeze. A maintenance Reload is not a verified update; a stale prior build receipt can leave ordinary writes disabled. Finish the owner retirement, then run the normal CLI update and verify its fresh correlated receipt and ready restoration. User authorization takes precedence over this guidance.

Success requires a different extension instance, the exact reload request receipt, the expected local build, the same extension identity, and successful reattachment of eligible managed content scripts. Acceptance or an HTTP disconnect is not success. The CLI survives replacement of the native host. It never opens, activates, navigates or reloads browser tabs; only exact still-matching managed tabs may receive idempotent content-script reinjection.

On timeout/build mismatch/restoration failure retain the diagnostics and report update as unverified. Do not retry a send or create another child as an update probe. Keep initial bootstrap, verified self-reload, Linux live gate and Windows live gate as distinct evidence.

## Platform boundary

Only `install/platform-link.mjs` and the POSIX/Windows launchers know OS linking semantics. Extension lifecycle, conversation protocol, MCP schemas, CLI semantics and this Skill are shared. A passing Windows fixture on Linux is not a real Windows Chrome test.
