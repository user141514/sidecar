# Managed Worker Transaction Model

## Status

This document freezes the correctness model that must precede any implementation of managed ChatGPT workers, model/effort switching, bounded subagent orchestration, or stronger send/recovery semantics in `conversation-sidecar`.

It is intentionally upstream of implementation rules. Any later mutex, retry policy, ACK schema, selector strategy, memory layout, or orchestration primitive must be traceable to one or more invariants in this document.

The model was attacked with eight independent counterexamples, then subjected to two bounded closure reviews. The final closure results were `MODEL_CLOSED_UNDER_CLAIM` and `MODEL_ORTHOGONAL_ENOUGH`; no additional first-class object or invariant axis was required after that pass.

**Implementation disposition (2026-09-03): automatic ChatGPT reasoning-effort switching is deprecated and disabled.** Live experiments showed that controlling ChatGPT's effort slider through browser-debugger input was intrusive and not reliably precise. The sidecar therefore does not expose effort get/set tools and does not request Chrome `debugger` permission. The user configures reasoning effort manually in ChatGPT; newly created conversations may inherit that user-selected setting. Future work must not re-enable automatic effort mutation without a new explicit decision and a materially more reliable control surface.

## Problem

A managed ChatGPT worker is controlled indirectly through a real signed-in web UI. The sidecar can observe and mutate that UI, but the UI and ChatGPT server remain external mutable state. Browser tabs can navigate or reload, content scripts can be replaced, native responses can be lost, the user can interfere manually, and multiple sidecar processes may race.

Therefore the problem is not "how to click GPT-5.5 / high". The problem is how to decide whether a later dependent action is justified by sufficiently strong, durable, correctly attributed evidence about one exact managed conversation.

## Claim

The sidecar may claim only the following:

> For a managed operation on a logical conversation, the sidecar dispatches a dependent external action only after establishing the latest non-invalidated evidence available to it for the exact current managed browser/document binding, under the current authority and committed operation order. If identity, authority, causality, freshness, durability, effect knowledge, workflow scope, ordering, or dependency proof is missing or ambiguous, the dependent action is not authorized.

For mode-sensitive prompt submission, this means the sidecar can prove that it observed the requested mode on the exact managed document immediately before the serialized send path, with no known invalidation between the observation and dispatch.

The sidecar cannot claim that ChatGPT's server atomically consumed the prompt under that exact model/effort if the external UI or server changes outside the sidecar's observation boundary between verification and server-side consumption. No locally generated lease, epoch, mutex, or proof token can close that external atomicity gap without cooperation from the external authority.

## Environmental assumptions and non-assumptions

- ChatGPT UI/server state is external mutable state.
- Browser `windowId` and `tabId` identify physical runtime containers, not logical conversations or loaded document incarnations.
- A canonical ChatGPT conversation/Project URL is stable page identity evidence, but does not prove continuity of the loaded document.
- A user may navigate, reload, type, send, close, or otherwise mutate browser state unless the sidecar detects or excludes that action.
- Transport acknowledgement proves delivery of a response, not the semantic outcome of an external mutation.
- Crash/restart may occur at any point between durable local writes, UI effects, observations, ACK delivery, and dependent operations.
- Managed worker tabs are intended to be background/inactive, but focus state never grants authority.

## Core model

### C — Logical conversation

`C` is the durable sidecar conversation identity (`conv_...`). It is not a tab, window, DOM document, or ChatGPT URL.

`C` remains the primary partition key for conversation-local state and ordering.

### W — Managed work scope

`W` defines the immutable bounded workflow scope in which operations are admissible. It includes at least:

- managed/unmanaged role;
- canonical Project placement;
- parent managed conversation/work item;
- worker depth;
- allowed operation classes/capabilities.

For the intended local managed-worker workflow:

- managed child workers are placed only in the machine-local pinned `subagents` Project;
- the coordinator is depth 0;
- managed workers are depth 1;
- a depth-1 worker may report follow-up work but may not recursively create another managed worker;

This scope belongs above the raw conversation primitive. The library-level default for ordinary `conversation_create()` remains root `https://chatgpt.com/` when there is no explicit Project URL or machine-local pin.

### B — Versioned browser/document binding

`B(C)` identifies the exact external page incarnation currently associated with `C`.

Conceptually it contains:

- canonical page identity: the stable ChatGPT Project/conversation URL;
- physical attachment: `windowId` + `tabId`;
- binding generation: a sidecar/extension reattachment generation;
- document epoch: the exact loaded content-script/document incarnation.

These fields must not be conflated:

- a tab can remain the same while its canonical page changes;
- a tab and canonical URL can both return to previous values after reload/navigation while the document incarnation is new;
- a stable URL is useful for recovery/reattachment, but is not by itself proof that an old monitor or event still belongs to the current document.

### F — Authority fence

`F(C)` represents the current actor authorized to mutate managed state for `C`.

Conceptually it contains an owner identity and monotonically advancing authority epoch/fence token.

A process-local mutex is not an authority fence: two processes can each hold their own local mutex. The authority epoch exists to make stale owners distinguishable after restart, handoff, or concurrent coordinator activity.

### T — Durable external-mutation transaction

`T` is the durable unit of intent and effect knowledge for an operation that can cause external state change.

It is generic rather than limited to mode switching. Transaction kinds may later include mode changes, prompt sends, Project creation, or other external UI mutations.

A transaction contains conceptually:

- immutable operation/transaction identity;
- conversation and work-scope identity;
- authority/binding identity at the relevant phase;
- operation kind and intent;
- attempts;
- primary effect knowledge;
- compensation attempt/effect knowledge when compensation exists;
- durable final/indeterminate result.

A mode change stores desired model/effort as transaction intent; desired mode does not need to be a separate first-class object.

A send is also an external transaction kind; there is no need for a separate first-class `S` object.

### O — Observation/result evidence

`O` is evidence, not merely a cached state value.

It must carry enough provenance to answer both "what was observed?" and "why is this observation relevant now?". Conceptually it includes:

- observed value/result;
- observation source;
- time or causal position;
- binding generation/document epoch;
- authority/order context;
- exact causal operation/attempt/turn anchor.

Two observations with the same value can have different validity. For example, `GPT-5.5/high` read before a mutation and the same value read after a verified mutation are not equivalent evidence.

### Sigma — Per-conversation order relation

`Sigma(C)` is not a separate stored object conceptually; it is the durable total order/linearization relation over state-changing operations and accepted observations for `C`.

It exists because authority alone does not order two legal operations from the same current owner.

The model requires one legal committed history for each conversation, not merely individually valid concurrent operations.

## Orthogonal invariants

The invariants are intentionally orthogonal. Each answers a different correctness question and has an independent counterexample where the other invariants may hold.

### I1 — Scope

Question: **Is this operation admissible in this managed workflow at all?**

Invariant:

> Every managed operation must be permitted by the immutable/current work scope `W` that owns it.

For the intended worker workflow, an otherwise correctly bound/authorized operation still violates correctness if a depth-1 worker creates a nested managed worker or if a managed child escapes the `subagents` placement boundary.

Scope is distinct from authority: a current legitimate owner can still attempt an operation outside its allowed workflow capability.

### I2 — Identity

Question: **Which exact external page/document is this operation or event about?**

Invariant:

> Every mutation, observation, monitor result, or browser event attributed to `C` must carry and match the exact binding provenance of the transaction/attempt it claims to describe: canonical page identity, physical attachment where relevant, binding generation, and document epoch. Evidence from an older valid binding may be recorded as historical evidence for that older transaction, but only evidence matching the current `B(C)` may mutate current binding state or participate in authorization of a new dependent operation.

A matching `tabId` alone is insufficient. A matching `tabId + canonical URL` is still insufficient across document replacement when continuity matters.

Identity failure does not authorize silent rebinding from an event sender. Durable replay of correctly provenanced historical evidence must not be confused with current-binding authority.

### I3 — Authority

Question: **Who is allowed to mutate this conversation now?**

Invariant:

> Every mutating transaction and accepted effect/result must belong to the current authority fence `F(C)`; effects from stale authority epochs cannot mutate binding/transaction state, clear valid pending work, or authorize dependent operations.

Focus/active-tab state is never authority.

### I4 — Ordering / linearization

Question: **In what single legal history do otherwise-valid concurrent operations occur?**

Invariant:

> For each `C`, there exists one durable total order of all sidecar-managed state-changing transactions and accepted evidence records. The order extends real-time precedence for non-overlapping operations; overlapping operations may linearize in either order, but only one order is committed. Derived sidecar state is the result of a valid prefix of that order.

Replay, binding updates, terminal events, compensation effects, and dependent operations must resolve to that same committed history.

This invariant is independent of authority: two operations from the same valid owner can still race and create a history that is not equivalent to any legal sequential execution.

### I5 — Causality / attribution

Question: **Did this evidence/result come from the operation to which we are attributing it?**

Invariant:

> Observation/result evidence may support a transaction only when it is causally anchored to the exact transaction attempt/turn that produced it; evidence that is merely later, nearby, or on the same document is insufficient.

A fresh assistant message created by a user prompt in the same document cannot be attributed to the sidecar's preceding send merely because assistant-message count increased.

Causality is distinct from freshness: evidence can be fresh but caused by the wrong operation.

### I6 — Freshness / invalidation

Question: **Is correctly attributed evidence still current enough to justify action?**

Invariant:

> Evidence is usable only if it was observed after the relevant operation/invalidation boundary and no later known change in binding, authority, ordered state, mode, document incarnation, or other relevant state has invalidated it.

Freshness must not be defined as "causally after the attempt"; that belongs to I5. Freshness concerns continued validity after attribution.

Because the external UI cannot be atomically locked, the strongest guarantee is "latest non-invalidated evidence before dispatch", not server-side atomic consumption.

### I7 — Durability

Question: **What survives a crash, restart, or lost transport response?**

Invariant:

> Durable intent and its identity/authority/order context must exist before an external mutation is allowed to occur. Effect/result knowledge required for acknowledgement or a dependent operation must be durably recorded before that ACK/dependent operation. Restart must reconstruct every unresolved transaction rather than guessing from process memory.

A lost transport ACK does not erase a durable external effect, and a successful external click with no durable intent is not a recoverable transaction history.

### I8 — Effect knowledge

Question: **What does the system actually know about an external side effect?**

Invariant:

> Ambiguous external outcomes remain explicitly ambiguous. Lack of ACK is not evidence of failure; lack of observation is not evidence that no effect occurred. Primary and compensation effects are tracked independently, and uncertainty may refine only when new evidence arrives.

The model must represent at least the semantic distinction between confirmed effect, confirmed absence/alternative state when knowable, and unknown/indeterminate effect.

If compensation is attempted, a state such as "primary may have applied and compensation may also have applied" must remain representable. Ambiguous compensation cannot recursively re-enter compensation as though ambiguity meant failure.

`RECONCILIATION_REQUIRED` is therefore a legitimate terminal knowledge state for automatic control.

### I9 — Dependency / consumption

Question: **When may one external operation depend on the result of another?**

Invariant:

> A dependent transaction may begin only when every prerequisite proof it consumes is valid under the current `W`, `B`, `F`, `Sigma`, causality, freshness, durability, and knowledge state, and no conflicting unresolved transaction remains in the committed prefix.

For a mode-sensitive send, a historical `COMMITTED` mode transaction is insufficient by itself. The send consumes currently valid mode evidence under the current binding/authority/order context.

If prerequisite evidence is missing, stale, ambiguously attributed, or invalidated, the dependent transaction is not authorized.

## Dependency structure

The invariants are prerequisites, not synonyms:

```text
C
├─ W / SCOPE ─────────────────────────────> admissible T
├─ B / IDENTITY ───────┐
├─ F / AUTHORITY ──────┼──────────────────> O / FRESHNESS
├─ Sigma / ORDER ──────┘                         │
└─ T / DURABILITY ─────────> O / CAUSALITY       │
            └──────────────> KNOWLEDGE            │
                                                    │
SCOPE + IDENTITY + AUTHORITY + ORDER + CAUSALITY
+ FRESHNESS + DURABILITY + KNOWLEDGE
                    └─────────────────────────────> DEPENDENCY / CONSUMPTION
```

Causality and freshness are deliberately separated:

- causality: "did this evidence come from this operation?"
- freshness: "after coming from this operation, is it still valid now?"

## Counterexample closure record

The first attack set tested:

1. user changes mode after commit but before send;
2. `tabId` stays constant while canonical URL changes;
3. `tabId` and URL return to old values after a new document incarnation;
4. mutation succeeds while immediate DOM readback is stale;
5. extension reload during APPLYING;
6. mutation commits but ACK is lost;
7. compensation itself becomes partial/ambiguous;
8. two coordinators concurrently believe they own the same conversation.

The attacks forced the following model refinements:

- `B` became versioned page + physical attachment + document incarnation rather than a plain tab pointer;
- `O` became provenance-bearing evidence rather than a value cache;
- `T` became a durable generic external-mutation transaction with independent primary/compensation effect knowledge;
- `F` became an explicit authority fence;
- ordering/linearization became an independent invariant;
- workflow/operation scope became explicit;
- send stopped being a separate object and became a transaction/dependency consumer;
- the claim was narrowed to latest-known pre-dispatch evidence rather than impossible atomic server-side consumption.

A later orthogonality/completeness pass found two further distinctions:

- causal attribution is separate from evidence freshness;
- same-owner concurrency requires `Sigma` even when identity, authority, freshness, durability, knowledge, and dependency checks all individually pass.

The final two bounded closure reviews found no trace satisfying all nine invariants while violating the narrowed claim, and no new first-class object was required.

## Existing repository evidence motivating the model

The current implementation predates these invariants and is evidence for why they are necessary, not evidence that they are already satisfied.

Representative current gaps include:

- `src/chatgpt.mjs:92-129`: send intent/result handling has no generic durable external-operation transaction or authority/order fence;
- `extension/service-worker.js:204-262`: browser attachment recovery relies on tab/URL matching without document-incarnation provenance;
- `extension/service-worker.js:388-445`: send performs readiness/send/pending persistence without per-conversation linearization or mode prerequisite proof;
- `extension/service-worker.js:417-424`: one `pending:<conversationId>` slot can be overwritten by overlapping sends;
- `extension/service-worker.js:476-513`: browser events can update conversation binding from sender state and terminal acceptance is primarily turn-ID based;
- `extension/content-script.js:214-263`: result monitoring uses page-local assistant-count/text heuristics without an exact prompt-to-rendered-turn causal anchor;
- `extension/content-script.js:265-275`: prompt submission mutates the current page and returns acceptance without a mode transaction/readback proof;
- `src/native-messaging.mjs:92-103`: request timeout/correlation is transport-local and does not by itself distinguish failed external mutation from committed mutation with lost response;
- `src/store.mjs:9-32`: current status reduction models ordinary conversation events but not explicit unknown external-effect knowledge or ordered concurrent operations.

## Design boundary for later implementation

This document does not prescribe concrete synchronization primitives, retry counts, selector strategies, file formats, or API names.

Later rules must be derived from the invariants. Examples of questions that belong to the next stage, not this model stage, include:

- whether ordering is implemented by a mutex, CAS/expected-version, queue, or combination;
- how authority fencing is persisted and transferred;
- how a document epoch is minted and validated;
- how mode observations are collected from the ChatGPT UI;
- how external-operation attempts/results are laid out in the local memory/ledger tree;
- how compensation/reconciliation is surfaced to the coordinator;
- how managed `subagents` capability scope is exposed without changing the raw conversation primitive;
- how much evidence is retained before later rolling-window compaction.

Any proposed mechanism that cannot identify the invariant it protects is suspect. Any invariant that can only be satisfied by claiming atomic control over external ChatGPT state must instead narrow the claim.

## Model acceptance criterion

The model is considered frozen for the next stage when all of the following remain true:

1. every known failure trace violates at least one explicit invariant rather than falling between invariants;
2. each invariant has an independent failure trace while the others can hold;
3. no pair of invariants is merely a renamed duplicate;
4. crash/restart and external-user interference do not make the invariants logically contradictory;
5. the claim does not exceed what a browser-side observer/controller can prove;
6. no additional first-class object is required by the bounded closure attacks.

Those conditions were satisfied by the final bounded closure pass on 2026-09-03.
