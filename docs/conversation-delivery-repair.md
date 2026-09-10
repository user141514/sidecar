# Conversation delivery repair — 2026-09-10

## Correctness model

A local conversation allocation is not a ChatGPT thread. `create` reports `phase: allocated`, `threadCreated: false`; a real browser thread URL and a completed response are the live acceptance evidence.

Sending records `send_intent`, then waits for browser acknowledgement. A bridge timeout/disconnect or an unacknowledged prepare/submit is `delivery_uncertain`, not proof of failure. Its durable turn blocks another send, including after a host restart. Late terminal evidence remains collectible. A completion cannot be downgraded by a late acknowledgement or timeout.

The extension fences concurrent sends by both conversation and tab. Recovery callbacks and terminal acknowledgements are not held behind the long send fence, avoiding a lock cycle. Pending intent is durable before the first prompt mutation. Explicit prepare/submit rejection releases pending and publishes a durable terminal error; transport uncertainty preserves pending.

## Timing

Content readiness has an elapsed deadline (normally 20 seconds; stale attachment retry adds 2 seconds). Individual pings are bounded at 2 seconds, prepare at 60 seconds, submit at 15 seconds and monitor-start acknowledgement at 2 seconds. The bridge budget is 120 seconds; the CLI budget is 130 seconds. These budgets bound waiting, not cancellation. Unresolved pending state must not be erased to enable a retry or reload.

## Identity and diagnostics

Project identity strips a display slug only following a 32-hex stable ID. Synthetic/nonstandard IDs remain unchanged. The same normalization applies to attachment matching and reload restoration. `extension-status.operations` lists active send conversation/turn/tab, phase and start time.

## Validation

Regression coverage includes Project slug redirect without allocating another tab; persistence before prepare and loss of its reply; simultaneous same-conversation and same-tab sends; definite pre-submit terminal evidence; real bridge timeout with persistent store; host restart after uncertainty; late completion/ACK ordering; and controller collection after uncertain delivery.

Linux and Windows live acceptance must be recorded separately after verifying loaded extension build and instance. Test requests use only the existing subagents Project, then reuse the same conversation for a second turn. Do not equate an allocated local ID, a submitted click, or a mock test with successful live completion.
