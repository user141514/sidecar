# Conversation Sidecar V0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Linux-only unattended sidecar that creates one ChatGPT conversation in the user's existing Chrome, monitors it asynchronously, persists the raw response, and exposes create/send/read through MCP.

**Architecture:** Plain Node.js 24 with no runtime dependencies. A fixed-ID MV3 extension is installed once in the user's real Chrome profile and controls ChatGPT windows/tabs. The extension uses Chrome Native Messaging to auto-start the Node sidecar; the same process serves localhost MCP and writes an append-only JSONL ledger.

**Tech Stack:** Node.js 24 ESM, Chrome Manifest V3 extension APIs, Chrome Native Messaging, `node:http`, `node:test`, JSON/JSONL.

**Spec:** `docs/superpowers/specs/2026-09-02-conversation-sidecar-v0-design.md`

## Global Constraints

- Do not modify DevSpace or Orca.
- Linux-only V0; branch name must be `feat/chatgpt-conversation-linux`.
- Reuse the existing signed-in Chrome profile without cookie copying.
- Operational create/send/read must not use CDP / `DevToolsActivePort` / Playwright / Puppeteer.
- One-time extension installation is allowed; normal operation afterward must require no recurring user approval.
- No third-party runtime dependencies.
- `events.jsonl` is append-only source of truth.

---

### Task 1: Durable local ledger

**Files:** `src/store.mjs`, `test/store.test.mjs`

- [x] Persist conversation metadata and append-only events.
- [x] Reconstruct latest durable status and raw response.

### Task 2: Native Messaging transport

**Files:** `src/native-messaging.mjs`, `test/native-messaging.test.mjs`

- [x] Implement Chrome's little-endian length-prefixed native message framing.
- [x] Handle fragmented input.
- [x] Correlate request responses and forward asynchronous extension events.

### Task 3: Extension-backed conversation host

**Files:** `src/chatgpt.mjs`, `test/chatgpt.test.mjs`

- [x] Create conversation through the extension bridge.
- [x] Return from send after browser submission is accepted.
- [x] Persist later extension completion/error events to the ledger.

### Task 4: Manifest V3 extension

**Files:** `extension/manifest.json`, `extension/service-worker.js`, `extension/content-script.js`, `test/extension.test.mjs`

- [x] Declare deterministic key, native messaging, windows/tabs/storage, and ChatGPT host access.
- [x] Reconnect Native Messaging after disconnect.
- [x] Create one managed normal Chrome window0; later conversations use tabs inside window0.
- [x] Route send requests to the correct ChatGPT tab.
- [x] Submit and monitor one turn in the content script; emit raw completion/error events.

### Task 5: Native host + MCP surface

**Files:** `src/server.mjs`, `test/server.test.mjs`, `install/com.conversation_sidecar.host.json`

- [x] Reserve stdout for Native Messaging frames and diagnostics for stderr.
- [x] Serve localhost MCP with exactly create/send/read.
- [x] Register fixed extension origin in the user-level Native Messaging manifest.
- [x] Prove formal server runtime does not import CDP or `DevToolsActivePort`.

### Task 6: One-time Chrome trust bootstrap

- [x] Verify unattended default-profile CDP/bootstrap is intentionally blocked by Chrome 136+ and reject that design.
- [x] Restore GNOME Chrome launcher to ordinary Chrome startup.
- [x] User loads `/home/ad/gitproject/conversation-sidecar/extension` once via `chrome://extensions` → Developer mode → Load unpacked.
- [x] Verify extension id equals `cfifihieaffhniimpimnfmignbbdaalb`.
- [x] Verify extension auto-starts the Native Messaging host and `127.0.0.1:7337` listens.

### Task 7: Bounded real gate

- [x] One historical live cycle proved create → send returns early → local generating → completed raw response in `events.jsonl`.
- [ ] After window0 code is installed/reloaded, perform at most one explicitly authorized bounded placement check: first managed conversation establishes window0; a later create adds only a tab inside it.
- [ ] Do not close Chrome, restart Chrome, or create additional windows as part of this gate.

### Task 8: Logical identity and restart reattachment

**Files:** `src/chatgpt.mjs`, `extension/service-worker.js`, `test/chatgpt.test.mjs`, `test/extension-runtime.test.mjs`

- [x] Replace process-local `conversationIds` authorization with durable ledger existence/read state.
- [x] Pass the ledger's latest `externalUrl` into `conversation_send` as durable identity evidence.
- [x] Persist the canonical ChatGPT `/c/...` URL back into extension conversation state when completion/error events arrive.
- [x] Resolve browser attachment before every send: reuse the registered live tab when valid; otherwise match the stable URL inside logical window0; otherwise reopen that URL in window0 and persist the new `tabId/windowId`.
- [x] If the physical window0 no longer exists, allow `ensureWindow0()` to create one replacement physical window and attach the old logical conversation to its initial tab.
- [x] Prove sidecar-process restart recovery and stale-tab reattachment with automated tests before implementation.
- [x] Restart only the native sidecar process, then prove the same logical conversation continues on the same canonical ChatGPT URL without restarting Chrome.
- [x] Keep full Chrome-restart recovery as a natural-future live gate rather than forcing a browser restart for testing.
- [x] Recover a pre-extension-reload matching tab by reloading that settled tab when its content script is no longer reachable.
- [x] Keep the native bridge request timeout above the extension's maximum content-script readiness budget.

### Task 9: Durable terminal-event delivery

**Files:** `extension/service-worker.js`, `src/native-messaging.mjs`, `src/chatgpt.mjs`, `test/extension-runtime.test.mjs`, `test/native-messaging.test.mjs`, `test/chatgpt.test.mjs`

- [x] Persist `response_completed` / `error` in `chrome.storage.local` outbox before clearing the pending turn.
- [x] Replay outbox events after Native Messaging reconnect.
- [x] Acknowledge terminal events only after the sidecar has durably recorded them.
- [x] Deduplicate replayed terminal events by stable `eventId` before acknowledging them.
- [x] Delete an outbox record only after its `event_ack` arrives from the sidecar.

### Task 10: Git boundary

- [x] Initialize this directory as its own Git repository.
- [x] Create branch `feat/chatgpt-conversation-linux`.
- [x] Push `feat/chatgpt-conversation-linux` to `origin`.
- [x] Keep DevSpace and Orca source outside this repository and untouched by this feature work.

### Task 11: Project-scoped conversation foundation

**Files:** `src/server.mjs`, `src/chatgpt.mjs`, `src/store.mjs`, `extension/service-worker.js`, `README.md`, project-related tests.

- [x] Accept an explicit ChatGPT Project home URL on `conversation_create`.
- [x] Restrict Project targets to canonical `https://chatgpt.com/g/g-p-.../project` URLs.
- [x] Treat `/g/g-p-.../c/...` as a stable conversation URL for restart/reattach.
- [x] Add `project_pin` to persist a default Project locally across sidecar restarts.
- [x] Let an explicit `project_url` override the pinned default for one create.
- [ ] Do not live-test Project conversation creation until explicitly authorized; when authorized, apply the staggered 15–20 second launch rule for probe-style requests.
- [ ] Keep automatic sidebar Project discovery and Project creation as a separate follow-up; do not mix brittle UI discovery into the URL-based pinning path.
