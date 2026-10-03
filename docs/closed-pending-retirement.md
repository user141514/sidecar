# Closed unknown-submit retirement

## Goal and boundary

A completed browser call can leave a logical `pending:*` entry in `submitting` when its submission acknowledgement is uncertain. Closing the original tab and withdrawing supervision do not prove delivery or non-delivery. They can nevertheless prove that the old attempt has no future browser execution after the writer and content-effect barriers drain.

The operator needs to retain the unknown result and all original history while retiring that attempt permanently. This is an explicit local maintenance operation; the supervised conversation cannot invoke it through MCP. It does not send, refresh, open, navigate, or close browser tabs.

## Invariants

- Original pending, send mailbox, ledger, and missing effect receipt remain unchanged. Delivery stays unknown/uncertain.
- The host proves the exact current unknown send from its ledger, including its Watchdog registration generation and canonical conversation identity.
- The registration must already be durably revoked. Missing, active, mismatched, or corrupt authority is insufficient.
- Native inspection and retirement bind the pending digest, conversation, turn, request, target, extension instance, build, operation, and writer epoch.
- The exact original tab is absent and no other open tab represents the target conversation. Browser lookup failure is not closure proof.
- Actual writer/content promises are drained, effect journals and outbox are empty, and an exclusive barrier prevents concurrent writes and terminal-event handling during retirement.
- A separate durable retirement receipt keeps the result unknown and fences old sends, recovery, adoption, monitoring, and late events. Failure to persist or verify a receipt cannot release the reload blocker.
- `pendingCount` includes retired attempts; `retiredPendingCount` counts matching receipts; only those records are excluded from `blockingPendingCount`. Retirement is not a recoverable or delivered receipt.
- Repeating the same operation reconciles its receipt. Changing the operation identity or snapshot cannot overwrite an existing retirement.

## Interfaces

The integrated host exposes loopback, non-browser JSON routes for inspection and explicit retirement, consumed by the local CLI. They are not public MCP tools. The host validates durable business identity, obtains a current writer-quiescence acknowledgement, asks the native writer for retirement, validates the returned receipt, and appends an idempotent audit event. The audit event does not complete the original turn or clear the mailbox.

The native writer owns the pending digest, closed-target proof, exclusive maintenance barrier, durable retirement receipt, and late-message fences. Inspection returns identifiers and eligibility facts without prompt text.

## Activation from the older extension

The older extension cannot retire an unknown submitting record and its normal update guard remains valid. After a clean tested release is staged through Runtime Home, the user can perform a manual bootstrap Reload of the same extension identity. The historical reload receipt's build mismatch remains an explicit failed-restoration state; it is not changed into success. Normal browser writers are blocked in this state while inspection, writer-epoch claim/quiescence, and explicit retirement remain available.

The operator then inspects and retires only the proven closed attempt. A subsequent standard `extension-update` obtains a new correlated reload receipt and verifies a different instance, exact target build, same extension identity, and ready restoration. No force option or manual storage deletion is introduced.

## Counterexamples and acceptance

Tests cover active/missing/wrong registration, changed digest/instance/build, open or re-opened target, lookup failure, active writer promises, pending content effects, outbox entries, persistence failure, idempotency conflict, restart, forged/mismatched receipt, and late terminal/nonterminal events. Host tests verify exact ledger-to-registration mapping, immutable unknown outcome, no mailbox clearing, audit retry, and exclusion from browser/MCP entry points.

Live acceptance occurs only after the user bootstrap step: re-read authoritative state; inspect the single known failed test attempt; prove native retirement while retaining pending/history; complete verified extension update; repeat the dedicated Medium gate inside the canonical `subagents` Project; allocate test conversations through Sidecar with that explicit Project URL and record their internal conversation IDs and final persistent URLs (never use root new-chat pages for child tests); run a new ACTION to owned REVIEW to DONE lifecycle; verify UI unbind, revoked-generation rejection, and empty-registry quiescence. Failed attempts are never replayed.

## Rollback

Source checkpoint: `rollback/sidecar-pre-retirement-20261003` at `2fa5ffea6def6a4122cf33e87798baebd0d590e4`. Before activation, the known live Runtime Home release remains `bda64be59d56d044dd5bb296cdbe343c379d380d` (build `95e4786efee3bee3a1a6ea072de8a2ac8c1196653c32ed37c2c196d4a152c52b`). Code rollback preserves current desired membership and all unknown/retired records. Older code may count the retained record as blocking again; it must never be made to pass by deleting that record.
