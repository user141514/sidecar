# Conversation send mailbox — devnbook9

## Outcome and authority

User approved replacing Watchdog direct writes with a Sidecar-owned intent mailbox, and explicitly fixed implementation to devnbook9. Do not change pc1 or dcomd7 in this task. Sidecar source: E:/Dev/multi-conversation-mymem-discovery-win, base 2778370, branch feat/conversation-mailbox. Watchdog source: E:/DevSpace/worktrees/watchdog-5a0ae028, base e924dfc, branch feat/mailbox-intents. The running Watchdog is an installed copy in E:/DevRuntime/chat-watchdog-venv, not the legacy E:/Dev/chat-watchdog directory.

## Minimal model

Coordinator/manual Sidecar sends and Watchdog continuation proposals enter one SendMailbox in the existing Sidecar runtime. Canonical ChatGPT conversation UUID, not local alias or Project slug, is the serialization key. Pending browser sends retain the existing ConversationStore and extension pending/outbox semantics. The mailbox is a durable send journal and serial executor, not a second work planner or a new daemon.

Watchdog publishes {target, expected:{userMessageId,assistantMessageId}, kind:'continue', text}. Sidecar derives an idempotency key from canonical target, expected IDs and kind, re-reads live state, resolves/adopts the existing conversation without creating a browser tab, and invokes the same host send path used by coordinators. `accepted` means submission, never task completion. Coordinator requests may supply an idempotency key; legacy callers receive a generated one. This does not infer the liveness of a remote coordinator that has not submitted any intent.

## Invariants

1. Only Sidecar invokes managed browser mutations. Watchdog's configured managed path cannot fall back to direct Relay writes, retry clicks, recovery agents, or reanchor sends when the owner is unavailable.
2. One effect executor per canonical target. A per-target process-safe lock never expires automatically; a crash cannot create a competing writer by timeout-based lock stealing.
3. Before an effect, persist the intent reservation. Duplicate IDs with different content are rejected; identical accepted requests return the same receipt. A crash/unknown transport result leaves a durable uncertain reservation and blocks automatic retries, including with new IDs.
4. Watchdog proposals carry both latest user and assistant message identities. Sidecar validates them immediately before preparing and again at the irreversible submit boundary. A newer user turn, an active assistant, a draft, missing evidence, or a human gate denies mutation. Old assistant final controls do not make a newer user turn idle.
5. All normal Sidecar sends share mailbox serialization; existing >=120-second admission remains a distinct pacing check after state validation. Old Watchdog pacing-only admission is rejected with mailbox_required after upgrade, so rollout fails closed.
6. Watchdog may observe through Relay but cannot use Relay to mutate in managed mode. Explicit standalone legacy mode remains available and makes no single-writer claim.
7. Existing uncertain/pending turns and terminal outbox entries are not cleared to permit installation or testing. Runtime updates require empty pending/outbox and re-read authoritative process/release/build/instance state afterward.

## Failure boundaries

Browser UI is not a transactional server API. No exactly-once delivery claim: after dispatch starts, an ambiguous failure is DELIVERY_UNCERTAIN and is not retried. A queued request without a durable effect reservation can be resubmitted explicitly and must pass fresh validation. An abandoned mailbox lock is an operator/reconciliation gate, not permission to delete it. Human UI sends outside Sidecar remain outside the broker's single-writer guarantee; the final DOM checks reduce that risk but cannot fence another independently controlled browser or profile.

Frontend retry/fault proposals are rejected as recovery_requires_reconciliation in this first mailbox release; they must not silently turn into another prompt or a direct Relay retry. This intentionally trades automatic fault-retry liveness for preventing ambiguous duplicate effects. Do not label this as full autonomous recovery.

## Verification

RED/GREEN gates: canonical alias collision; duplicate intent including response loss; changed payload with same ID; restart with pending dispatch; pacing denial followed by safe retry; old Watchdog admission denied; both orderings of coordinator and Watchdog intents; user-pending/draft/active/human-gate; changed DOM between prepare and submit; managed Watchdog with an unavailable owner never calls page.send_continue/retry_fault or AgentPool. Full Sidecar and Watchdog suites, package export/build identity checks, and bounded browser acceptance on an existing test conversation only. No intentional race injection into the research coordinator.
