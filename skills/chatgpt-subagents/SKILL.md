---
name: chatgpt-subagents
description: Use for managed ChatGPT web conversations and verified self-updates of the conversation extension from a local shell on Linux or Windows.
---

# ChatGPT conversation provider

The provider owns conversation transport and identity, not planning, memory, task routing or recursive delegation. Run the same `chatgpt-conversation` CLI on Linux and Windows. The distribution must contain `extension/`, `install/`, `src/` and this Skill; never load them from a different Sidecar checkout.

## Setup

Use Node 24 or newer. In the intended checkout run `npm link` to install the cross-platform CLI shim and `npm run install:host` to register that checkout's native host. Load its `extension/` once in the signed-in Chrome profile. Preserve the manifest key/extension ID.

Existing releases without `extension_status` / `extension_reload` need one manual bootstrap reload after installation. Do not substitute GUI automation, CDP attachment, browser restart or profile edits for that bootstrap. Do not automatically switch a working native-host registration to another checkout.

## Conversations

`chatgpt-conversation create --project <project_url>` allocates one durable conversation ID. For this user's live tests, use only the confirmed `subagents` Project. Send a self-contained bounded task with `chatgpt-conversation send <conversation_id> <prompt>`. Workers must not edit source or fan out when assigned read-only audits.

`send` acknowledges submission, not completion. Use `chatgpt-conversation read <conversation_id>` later. Keep the conversation and turn IDs; do not substitute tab/window IDs. A repeated `generating` ledger snapshot does not establish either live progress or a fault. Never infer failure from model latency or unchanged visible text alone.

## Verified extension updates

After updating local source through the approved Git workflow (SSH remotes), run `npm run extension:build`, then tests and audit. This prepares a local build fingerprint, not a remote download.

- `chatgpt-conversation extension-status` reports the running extension ID, version, build ID, instance ID, pending/outbox counts and last reload receipt.
- `chatgpt-conversation extension-update` (alias `extension-reload`) applies the staged unpacked extension and independently verifies the reconnect. Optional `--timeout-ms N`, 100–300000, default 30000.

The agent may invoke the verified CLI update when the user has authorized updating this installation. Do not click Chrome controls. If blocked by pending work or undelivered outbox entries, stop; there is no force option. Never clear those records merely to pass update admission.

Success requires a different extension instance, the exact reload request receipt, the expected local build, the same extension identity, and successful reattachment of eligible managed content scripts. Acceptance or an HTTP disconnect is not success. The CLI survives replacement of the native host. It never opens, activates, navigates or reloads browser tabs; only exact still-matching managed tabs may receive idempotent content-script reinjection.

On timeout/build mismatch/restoration failure retain the diagnostics and report update as unverified. Do not retry a send or create another child as an update probe. Keep initial bootstrap, verified self-reload, Linux live gate and Windows live gate as distinct evidence.

## Platform boundary

Only `install/platform-link.mjs` and the POSIX/Windows launchers know OS linking semantics. Extension lifecycle, conversation protocol, MCP schemas, CLI semantics and this Skill are shared. A passing Windows fixture on Linux is not a real Windows Chrome test.
