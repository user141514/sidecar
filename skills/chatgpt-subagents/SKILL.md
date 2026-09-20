---
name: conversation-workers
description: This skill should be used when the user asks to use Sidecar, conversation-work, chatgpt-conversation, conversation_worker, the canonical subagents Project, or to create/open/dispatch a real ChatGPT child conversation or child chat. It governs managed ChatGPT child conversations through Sidecar/WorkController and must not be substituted with DevSpace host_worker or Orca workers.
---

# ChatGPT Conversation Workers

The installed Runtime Home owns conversation transport, WorkController, WorkLedger, managed Project identity, pacing state and MemoryPool. Git checkouts/worktrees are source inputs only; after bootstrap, Native Messaging, stable CLI entrypoints and persistent data must not point directly at an arbitrary development checkout. Orca/orca-sub is not required for this runtime.

## Entry gate: establish Runtime Home authority first

Before any managed child creation, manual Sidecar transport, `project-find`, checkout inspection or recovery reasoning, establish the current machine's installed Runtime Home authority.

Prefer the `SIDECAR_RUNTIME_AUTHORITY` block injected by the UserPromptSubmit hook when present. It is derived from the current machine's Runtime Home config and PATH. If the hook is unavailable, read the platform Runtime Home `runtime.json` directly before execution:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/conversation-sidecar/runtime.json`
- Windows: `%LOCALAPPDATA%\\Conversation Sidecar\\runtime.json`

Require all of the following for managed worker execution:

- `state` is `ready`;
- `managed_project.name` is `subagents`;
- `managed_project.url` is a canonical `https://chatgpt.com/g/g-p-.../project` URL;
- stable `conversation-work` and `chatgpt-conversation` commands resolve from the installed user PATH.

Treat these as authority. Do **not** use a Git checkout/worktree path, a path remembered from another host, or a browser-search result as runtime authority. `project-find subagents` is diagnostic only; failure to parse the browser project list does not invalidate a ready Runtime Home canonical Project, and success does not outrank Runtime Home config. Never reconstruct the managed Project URL from memory and never fall back to root `https://chatgpt.com/`.

## Setup

Use Node 24 or newer. From the authoritative clean source checkout run `npm run bootstrap`. Bootstrap exports a verified immutable full Agent Runtime release, installs stable Runtime Home launchers, preserves/copies legacy data into one stable data root, and resolves the managed `subagents` Project.

Do **not** use `npm link` or `npm run install:host` as installation authority for a bootstrapped machine. Those commands remain development/legacy surfaces only.

A fresh machine may return `extension_trust_required` with `state: prepared`. Load the exact `extension/` directory reported for that Runtime Home release once in the signed-in Chrome profile, preserving the fixed extension identity, then run the same `npm run bootstrap` command again. Managed worker dispatch stays disabled until the runtime reaches `state: ready` with a canonical `subagents` Project URL.

If bootstrap detects an existing working Native Messaging registration outside Runtime Home, it must not switch it unless the user has authorized `--activate`. Do not bypass that gate by manually rewriting manifests, registry entries, browser profiles or checkout-local launchers.

## Managed conversation workers

Managed coordinator conversation workers use the stable Runtime Home `conversation-work` CLI or the equivalent `work_*` MCP tools. Their machine-readable worker kind is `conversation_worker` and backend is `sidecar`. Do not substitute DevSpace local provider workers (`host_worker`) or Orca workers for this route.

Use the normal managed flow:

1. `conversation-work create <goal>`
2. `conversation-work decide <work_id> '<decision-json>'`
3. `conversation-work dispatch <work_id> <frontier_id>`
4. `conversation-work collect <work_id>`

Do not run `project-find` before this flow. `WorkController.dispatch()` obtains the canonical `subagents` Project from Runtime Home and creates the child there. Missing/invalid Project identity is a hard error and must never fall back to root ChatGPT.

Creation pacing is owned by Sidecar transport, not by task decomposition. Multiple independent frontiers may exist and previously created children may keep running, but new physical ChatGPT conversation allocations are admission-controlled. On `reason: "pacing"`, respect `retryAfterMs`; do not bypass the gate with manual `chatgpt-conversation create`, another checkout, another CLI copy, or a root conversation.

Manual transport remains available through `chatgpt-conversation create [--project <project_url>]`, `send`, and `read` only when manual transport is actually intended. When `--project` is needed, take the URL from the current Runtime Home config, never from memory or a stale cross-host path. Do not use manual root conversations as a substitute for managed worker dispatch.

`send` acknowledges submission, not completion. Use `chatgpt-conversation read <conversation_id>` later or `conversation-work collect <work_id>` for managed work. Keep conversation and turn IDs; do not substitute tab/window IDs. A repeated `generating` ledger snapshot does not establish either live progress or a fault. Never infer failure from model latency or unchanged visible text alone.

## Verified extension updates

After updating local source through the approved Git workflow, build/test the source and run bootstrap to create or select a new verified Runtime Home release. Extension identity and build metadata travel with that release.

- `chatgpt-conversation extension-status` reports the running extension ID, version, build ID, instance ID, pending/outbox counts and last reload receipt.
- `chatgpt-conversation extension-update` (alias `extension-reload`) applies the staged unpacked extension and independently verifies the reconnect. Optional `--timeout-ms N`, 100–300000, default 30000.

The agent may invoke the verified CLI update when the user has authorized updating this installation. Do not click Chrome controls. If blocked by pending work or undelivered outbox entries, stop; there is no force option. Never clear those records merely to pass update admission.

Success requires a different extension instance, the exact reload request receipt, the expected local build, the same extension identity, and successful reattachment of eligible managed content scripts. Acceptance or an HTTP disconnect is not success. The CLI survives replacement of the native host. It never opens, activates, navigates or reloads browser tabs; only exact still-matching managed tabs may receive idempotent content-script reinjection.

On timeout/build mismatch/restoration failure retain the diagnostics and report update as unverified. Do not retry a send or create another child as an update probe. Keep initial bootstrap, verified self-reload, Linux live gate and Windows live gate as distinct evidence.

## Platform boundary

Only `install/platform-link.mjs` and the POSIX/Windows launchers know OS linking semantics. Extension lifecycle, conversation protocol, MCP schemas, CLI semantics and this Skill are shared. A passing Windows fixture on Linux is not a real Windows Chrome test.
