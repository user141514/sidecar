---
name: chatgpt-subagents
description: Use for managed ChatGPT web conversations and verified self-updates of the conversation extension from a local shell on Linux or Windows.
---

# ChatGPT Agent Runtime

The installed Runtime Home owns conversation transport, WorkController, WorkLedger and MemoryPool. Git checkouts are source inputs only; after bootstrap, Native Messaging, stable CLI entrypoints and persistent data must not point directly at an arbitrary development checkout. Orca/orca-sub is not required for this runtime.

## Setup

Use Node 24 or newer. From the authoritative clean source checkout run `npm run bootstrap`. Bootstrap exports a verified immutable full Agent Runtime release, installs stable Runtime Home launchers, preserves/copies legacy data into one stable data root, and resolves the managed `subagents` Project.

Do **not** use `npm link` or `npm run install:host` as installation authority for a bootstrapped machine. Those commands remain development/legacy surfaces only.

A fresh machine may return `extension_trust_required` with `state: prepared`. Load the exact `extension/` directory reported for that Runtime Home release once in the signed-in Chrome profile, preserving the fixed extension identity, then run the same `npm run bootstrap` command again. Managed worker dispatch stays disabled until the runtime reaches `state: ready` with a canonical `subagents` Project URL.

If bootstrap detects an existing working Native Messaging registration outside Runtime Home, it must not switch it unless the user has authorized `--activate`. Do not bypass that gate by manually rewriting manifests, registry entries, browser profiles or checkout-local launchers.

## Managed workers and conversations

Managed coordinator workers use `conversation-work` / the `work_*` MCP tools. `WorkController.dispatch()` is required to create every managed child inside the canonical `subagents` Project stored in Runtime Home config; missing Project identity is a hard error and must never fall back to root `https://chatgpt.com/`.

Manual transport remains available through `chatgpt-conversation create [--project <project_url>]`, `send`, and `read`. Do not use manual root conversations as a substitute for managed worker dispatch.

`send` acknowledges submission, not completion. Use `chatgpt-conversation read <conversation_id>` later or `conversation-work collect <work_id>` for managed work. Keep conversation and turn IDs; do not substitute tab/window IDs. A repeated `generating` ledger snapshot does not establish either live progress or a fault. Never infer failure from model latency or unchanged visible text alone.

For multi-worker use, preserve the controller's pacing contract. Do not bypass WorkController to burst-create child conversations.

## Verified extension updates

After updating local source through the approved Git workflow, build/test the source and run bootstrap to create or select a new verified Runtime Home release. Extension identity and build metadata travel with that release.

- `chatgpt-conversation extension-status` reports the running extension ID, version, build ID, instance ID, pending/outbox counts and last reload receipt.
- `chatgpt-conversation extension-update` (alias `extension-reload`) applies the staged unpacked extension and independently verifies the reconnect. Optional `--timeout-ms N`, 100–300000, default 30000.

The agent may invoke the verified CLI update when the user has authorized updating this installation. Do not click Chrome controls. If blocked by pending work or undelivered outbox entries, stop; there is no force option. Never clear those records merely to pass update admission.

Success requires a different extension instance, the exact reload request receipt, the expected local build, the same extension identity, and successful reattachment of eligible managed content scripts. Acceptance or an HTTP disconnect is not success. The CLI survives replacement of the native host. It never opens, activates, navigates or reloads browser tabs; only exact still-matching managed tabs may receive idempotent content-script reinjection.

On timeout/build mismatch/restoration failure retain the diagnostics and report update as unverified. Do not retry a send or create another child as an update probe. Keep initial bootstrap, verified self-reload, Linux live gate and Windows live gate as distinct evidence.

## Platform boundary

Only `install/platform-link.mjs` and the POSIX/Windows launchers know OS linking semantics. Extension lifecycle, conversation protocol, MCP schemas, CLI semantics and this Skill are shared. A passing Windows fixture on Linux is not a real Windows Chrome test.
