# Conversation Mailbox Implementation Plan

> **For agentic workers:** Execute inline using executing-plans and TDD; no new ChatGPT workers or watches for development.

**Goal:** Remove managed Watchdog browser-write authority and serialize all Sidecar sends with durable idempotent receipts.

**Architecture:** A filesystem-backed SendMailbox in the existing Sidecar process owns the effect reservation. The existing ConversationStore owns conversation lifecycle. The browser adapter validates the intent's expected message pair before prepare and before submit.

**Tech Stack:** Existing Node 24 modules and filesystem, Chrome extension JavaScript, Python 3.12 venv. No queue service, new daemon, or Conda.

**Spec:** ../specs/2026-09-15-conversation-mailbox-design.md

## Global constraints

Only devnbook9. Source bases 2778370 (Sidecar), e924dfc (Watchdog). Stable Runtime Home and installed Watchdog copy remain deployment authorities. Preserve >=120-second pacing, pending/outbox, same-conversation targeting, and NEED_INPUT. Unknown delivery never auto-retries. Explicit fault reconciliation replaces unsafe managed direct retry.

## Task 1: Durable mailbox

Files: new src/send-mailbox.mjs and test/send-mailbox.test.mjs.
Interface: SendMailbox({rootDir}).run(target, requestId, payload, operation), operation(markDispatching); canonicalTarget(url, fallbackId).
- [ ] RED tests: concurrent same-target max writers 1, URL aliases same key, duplicate receipt survives new instance, ID payload conflict, pending dispatch after crash blocks same/new IDs, failed preflight does not become an effect, pacing remains retryable.
- [ ] Implement using per-key promise queue, per-key filesystem lock, atomic journal replacement with file sync, and conservative unknown-delivery latch. No automatic stale-lock stealing.
- [ ] Run node --test test/send-mailbox.test.mjs; preserve error/receipt semantics.

## Task 2: Common host and browser boundary

Files: src/chatgpt.mjs, src/store.mjs, src/server.mjs, extension/content-script.js, extension/service-worker.js, explicit export file lists; focused tests.
- [ ] RED: coordinator and watchdog use same canonical mailbox, stale expected user/assistant rejected, old pacing-only Watchdog denied, persisted in-flight turn blocks newer request.
- [ ] Add store findByExternalUrl and metadata-only adopt; never allocate a browser tab for a watchdog intent. Host.proposeContinuation validates schema and exact live observation before side effects. Normal Host.send enters mailbox and accepts optional requestId.
- [ ] Add localhost JSON-only /internal/conversation-intents endpoint; reject browser Origin and unknown fields.
- [ ] Add side-effect-free exact-tab observation and existingOnly attachment for Watchdog. Preserve prepared snapshot until submit and recheck user/assistant/generation/draft/human gate at click time.
- [ ] Run focused Node tests; update export lists and extension build.

## Task 3: Watchdog producer

Files in Watchdog worktree: new intent_client.py, cli.py, supervisor.py, tests/test_intent_client.py, tests/test_supervisor_intents.py, README.md.
- [ ] RED: configured managed path never calls Relay sends, retries or recovery agents; failures and unknown responses stay closed; expected user and assistant IDs travel unchanged; repeated polls reuse intent identity.
- [ ] Implement SidecarIntentClient and Supervisor intent path. Translate prior --send-admission-url configuration into the sibling intent endpoint. Require explicit --legacy-direct-send for unbrokered operation. Reject conflicting/reanchor configuration rather than leaving a bypass.
- [ ] Run .venv/Scripts/python.exe -m pytest -q and pip check.

## Task 4: Integration and activation

- [ ] Full Node/Python regression, exported Runtime verification, stale/duplicate/restart integration test, read-only review of diff.
- [ ] Stage Sidecar first (legacy Watchdog gets mailbox_required), then install Watchdog producer package. Preserve rollback versions and registry snapshot.
- [ ] Require empty pending/outbox before verified extension-update; re-read /healthz, extension-status and exact daemon import path.
- [ ] Bounded real gate using existing test thread in subagents; do not reuse the research reviewer. Read actual DOM and durable receipt, do not treat output markers as proof of transport correctness.
- [ ] Commit/push tested branches, confirm exact remote heads, leave other hosts untouched. Report any unclosed live/behavior gates explicitly.
