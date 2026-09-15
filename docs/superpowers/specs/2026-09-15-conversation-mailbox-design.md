# Conversation send mailbox — devnbook9

## Outcome and authority

User approved replacing Watchdog direct writes with a Sidecar-owned intent mailbox, and explicitly fixed implementation to devnbook9. Do not change pc1 or dcomd7 in this task. Sidecar source: E:/Dev/multi-conversation-mymem-discovery-win, base 2778370, branch feat/conversation-mailbox. Watchdog source: E:/DevSpace/worktrees/watchdog-5a0ae028, base e924dfc, branch feat/mailbox-intents. The running Watchdog is an installed copy in E:/DevRuntime/chat-watchdog-venv, not the legacy E:/Dev/chat-watchdog directory.

## Minimal model

Coordinator/manual Sidecar sends and Watchdog continuation proposals enter one SendMailbox in the existing Sidecar runtime. Canonical ChatGPT conversation UUID, not local alias or Project slug, is the serialization key. Pending browser sends retain the existing ConversationStore and extension pending/outbox semantics. The mailbox is a durable send journal and serial executor, not a second work planner or a new daemon.

Watchdog publishes {target, expected:{userMessageId,assistantMessageId}, kind:'continue', text}. Sidecar derives an idempotency key from canonical target, expected IDs and kind, re-reads live state, resolves/adopts the existing conversation without creating a browser tab, and invokes the same host send path used by coordinators. `accepted` means submission, never task completion. Coordinator requests may supply an idempotency key; legacy callers receive a generated one. This does not infer the liveness of a remote coordinator that has not submitted any intent.

## Invariants

1. Only Sidecar invokes managed browser mutations. Watchdog's configured managed path cannot fall back to direct Relay writes, retry clicks, recovery agents, or reanchor sends when the owner is unavailable.
2. One effect executor per canonical target. A per-target process-safe lock never expires by time. Normal send paths never steal a lock. Reconciliation may fence an orphaned lock only when durable owner metadata exists and the recorded owner PID is proven dead; live or unreadable ownership remains blocked.
3. Before an effect, persist the intent reservation. Duplicate IDs with different content are rejected; identical accepted requests return the same receipt. The request identity crosses the browser boundary. After submit creates a new user turn, the Extension persists `EffectReceipt{requestId,conversationId,turnId,userMessageId,externalUrl}` before acknowledging Sidecar. A crash/unknown transport result remains uncertain unless this exact receipt is recovered; missing or mismatched evidence never authorizes retry.
4. Watchdog proposals carry both latest user and assistant message identities. Sidecar validates them immediately before preparing and again at the irreversible submit boundary. A newer user turn, an active assistant, a draft, missing evidence, or a human gate denies mutation. Old assistant final controls do not make a newer user turn idle.
5. All normal Sidecar sends share mailbox serialization; existing >=120-second admission remains a distinct pacing check after state validation. Old Watchdog pacing-only admission is rejected with mailbox_required after upgrade, so rollout fails closed.
6. Watchdog may observe through Relay but cannot use Relay to mutate in managed mode. Explicit standalone legacy mode remains available and makes no single-writer claim.
7. Existing uncertain/pending turns and terminal outbox entries are not cleared to permit installation or testing. Runtime updates require empty pending/outbox and re-read authoritative process/release/build/instance state afterward.

## Effect receipt and reconciliation

`EffectReceipt` is browser-side durable provenance, not a completion marker. It is created only after the content script observes a structurally identified new user message (`data-message-id`) produced by the submit attempt. Draft clearing, generation UI, Stop controls, prompt text equality, or elapsed time cannot create a receipt. The service worker stores the receipt in `chrome.storage.local` before delivering the accepted native response.

When Sidecar reads a `delivery_uncertain` turn, or receives the same stable Watchdog/coordinator request again, it queries the Extension for the exact request receipt. `FOUND` with matching request, conversation, turn and user-message identities allows the existing mailbox pending record to be atomically settled and the ledger to advance only to `generation_started`; assistant completion still requires the existing terminal/body evidence chain. `MISS`, transport failure, malformed receipt, or identity mismatch leaves the state unchanged and non-sendable.

A hard Sidecar crash can leave both a mailbox pending record and its filesystem lock. Locks carry `{pid, ownerId}`. Only reconciliation may replace the lock, and only after the recorded PID is no longer alive. Missing owner metadata, an alive PID, or an indeterminate ownership check is fail-closed. This is fencing for process-crash recovery, not timeout-based stale-lock stealing.

## Failure boundaries

Browser UI is not a transactional server API. This design now supports recovery from a Sidecar process/ACK crash when the Extension's durable EffectReceipt survives, but it still makes no universal exactly-once claim. Extension-storage loss, browser-profile loss, an effect that occurs before a receipt can be durably written, or evidence that cannot be uniquely matched remains DELIVERY_UNCERTAIN and is not retried. A queued request without a durable effect reservation can be resubmitted explicitly and must pass fresh validation. Human UI sends outside Sidecar remain outside the broker's single-writer guarantee; the final DOM checks reduce that risk but cannot fence another independently controlled browser or profile.

Frontend retry/fault proposals are rejected as recovery_requires_reconciliation in this first mailbox release; they must not silently turn into another prompt or a direct Relay retry. This intentionally trades automatic fault-retry liveness for preventing ambiguous duplicate effects. Do not label this as full autonomous recovery.

## Verification

RED/GREEN gates: canonical alias collision; duplicate intent including response loss; changed payload with same ID; restart with pending dispatch; request identity crossing into the Extension; new user-message identity required for accepted submit; EffectReceipt durable before native ACK; lost accepted ACK never synthesized into a business rejection; receipt-driven restart reconciliation without a second send; Watchdog uncertain continuation reconciles instead of resending; hard-killed mailbox owner fencing; live lock owner not stolen; pacing denial followed by safe retry; old Watchdog admission denied; both orderings of coordinator and Watchdog intents; user-pending/draft/active/human-gate; changed DOM between prepare and submit; managed Watchdog with an unavailable owner never calls page.send_continue/retry_fault or AgentPool. Full Sidecar and Watchdog suites, package export/build identity checks, and bounded browser acceptance on an existing test conversation only. No intentional race injection into the research coordinator.
