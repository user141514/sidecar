# Explicit existing-conversation adoption

## Outcome and ownership

Adopt an already-open ChatGPT conversation without creating, copying, navigating,
sending to, or stopping it. The external conversation UUID is unchanged. Sidecar
owns the durable ledger and writer epoch. The extension owns only the verifiable
browser attachment/effect receipt. Watchdog consumes the existing state/intent API;
it does not adopt conversations or maintain a second authority registry.

### Table A: minimal changes at the existing owner

| Owner | Change |
| --- | --- |
| Sidecar Host | Explicit operator-only adoption; reuse target mailbox and allocation primitive |
| ConversationStore | One provenance-bearing `conversation_adopted` baseline in the existing ledger |
| State reducer | Accept an inherited persisted user message without inventing a send/receipt |
| Extension | Exact UUID tab inspection/binding only; no browser creation or navigation |
| Watchdog | No adoption authority or production policy changes |

### Table B: real ownership gaps, not fallback opportunities

| Gap | Required invariant |
| --- | --- |
| Unowned URL has no ledger record | One canonical UUID, one logical binding |
| Original input was not sent by Sidecar | Explicit persisted user-message anchor and adoption provenance |
| Binding ACK can be lost | Reconcile durable effect receipt; do not repeat mutation blindly |
| Legacy direct writer may still exist | Operator handoff removes exact legacy writer before managed supervision |
| Page is gone, duplicated or navigated away | Refuse adoption; never open another tab to compensate |

## Model -> Claim -> Invariant -> Counterexample -> Minimal fix

`operator -> Sidecar target mailbox -> existing ledger reservation -> exact browser
binding receipt -> conversation_adopted -> normal state reducer -> Watchdog`.

`stateByTarget` originally searched only the Sidecar ledger. A visible Relay tab is
not a ledger record. `create()` couples local allocation to browser creation.
The legacy continuation API also implicitly creates a ledger during a send; it is
not a side-effect-free adoption primitive and is not used here.

The new operation uses a deterministic allocation identity derived from the exact
conversation UUID, and the existing mailbox's disk/in-process exclusion. The
explicit user-message UUID is an inherited anchor, never a synthetic message ID or
a DOM position/count. Existing observation code uses DOM relations only to reject
superseded anchors and associate replies, not to manufacture identities.

Before confirmation, state lookup returns `adoption_incomplete`. No send intent,
`prompt_sent`, or fictitious `generation_started` is inserted for adoption. A new
`conversation_adopted` event supplies the persisted user input's provenance and
turn identity; live observations determine progress/body/gate. Writer epoch stays
owned by the existing runtime lease.

Counterexamples tested: concurrent/alias adoption; acknowledgement loss with and
without a durable receipt; restarted host/extension; wrong epoch/message/UUID;
closed/navigated/duplicate tabs; conflicting ledger/browser binding; browser-Origin
requests; unchanged subagents Project; no implicit adoption on state reads.

## Operator contract

`POST /internal/conversation-adoption`, JSON, localhost non-browser callers only.
Not exposed in model-facing MCP tools.

```json
{
  "target": "https://chatgpt.com/c/<existing-conversation-uuid>",
  "expectedUserMessageId": "<explicit-persisted-user-message-uuid>",
  "expectedWriterEpoch": 3,
  "source": "human"
}
```

The epoch must be re-read from the current writer. An explicitly authorized
preflight may restore the installed content observer on the unique exact tab
after extension reload; it verifies the executed build and URL without navigation,
sending, or creating a ledger/browser owner. Wrong epoch cannot inject the observer.
The caller supplies a stable
message UUID, not a title, DOM index, first/last position or fuzzy URL. Repeated
adoption returns the same logical record and fresh authoritative state. No Project
pin, WorkController task, memory publication or research state is changed.

`accepted:true` proves confirmed binding/ledger adoption, not semantic task
completion, recovery success or useful progress. Always report separately:
process, API, exact target binding, and effect/progress evidence.

## Validation and rollout boundary

Run adoption/extension focused tests, complete Node suite from a clean commit,
package/runtime verification, and Watchdog's full suite. Before live handoff,
record old runtime release/build/epoch, exact legacy process command and target,
registry contents, and subagents attachments. Adopt only the explicitly authorized
URL after the exact legacy writer is absent. Never register the same URL while a
legacy writer is still active.

A live recovery probe must use a bounded infrastructure-only prompt and may not
resume or modify research. A failure to produce an effect receipt or causal new
turn is a failed/blocked live gate even when health and registration are green.

Base/rollback source: `e3b9140794c91acf0665799cf56e0c5d2adbb503` (Sidecar).
Watchdog base: `5023d6f68919e46c1225162811bd456122295a47`.
Rollback must unregister managed supervision first and prove its writer quiescent;
never overlap it with a restarted legacy direct writer. Keep the adoption ledger
for audit instead of deleting or rewinding conversation history.
