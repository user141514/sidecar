# Unified Conversation Runtime Design

## Outcome

Unify Sidebar/browser observation, Watchdog policy, and Coordinator task orchestration around one robotics-style communication model without moving browser-write authority out of Sidecar.

The target runtime is:

`Observation -> State Reducer -> Intent -> Dispatcher -> Command -> Effect -> Receipt`

with a separate control plane for ownership, lifecycle, epoch, pacing, and human gates.

This is a coordinated refactor of two repositories:

- Sidecar: owns authoritative `ConversationState`, dispatch serialization, browser commands, effect receipts, and control-plane fencing.
- Watchdog: owns observation/policy logic only and publishes intents against an exact authoritative state version.

Sidebar is treated as a human intent producer and state subscriber. The browser extension remains the browser driver and observation/effect sensor; it is not an authority for task state.

## Non-goals

- Do not add Kafka, RabbitMQ, Redis Streams, ROS2, DDS, or a new daemon.
- Do not make Sidecar automatically choose NEW versus REUSE.
- Do not introduce automatic context-saturation policy in this refactor.
- Do not change the existing single-writer mailbox and EffectReceipt safety contract except where required to consume the new state/intent schema.
- Do not make DOM state, Watchdog state, or Sidebar UI state independently authoritative.

## User-directed child allocation

Child allocation is an upper-layer intent, never a hidden transport heuristic:

- `NEW`: allocate a new managed conversation.
- `REUSE`: target one explicit existing managed conversation after reconciliation.
- `AUTO`: reserved for a future explicitly-authorized policy; not implemented by this refactor.

Sidecar must execute the requested mode safely but must not choose between NEW and REUSE on its own.

## Architectural roles

### Providers / observers

Providers emit facts without deciding control actions:

- browser DOM observation
- Extension EffectReceipt
- Sidecar ledger events
- terminal/body-completeness evidence
- human interaction provenance
- clock/pacing evidence

Observations may be plural, stale, unavailable, duplicated, or contradictory.

### Authoritative State Reducer

Exactly one Sidecar reducer combines available evidence into a durable `ConversationState` projection.

Only this projection is authoritative for policy and dispatch decisions. Local UI state, Relay snapshots, and Watchdog-local phases are observations, not competing authorities.

### Intent producers

- Sidebar -> `source=human`
- Watchdog -> `source=watchdog`
- Coordinator -> `source=coordinator`

Intent producers express desired actions but cannot perform browser writes.

### Dispatcher

Sidecar is the only managed dispatcher. It validates state version, ownership, gates, pacing, target identity, and current state immediately before a browser command.

### Effect sink

The Extension executes browser commands and records durable effect receipts. It must not infer coordinator policy, reuse policy, or task completion.

## Contract version

The first shared contract is `conversation-runtime/v1`.

All state and intent payloads carry:

```json
{
  "contractVersion": 1
}
```

Unknown versions fail closed. Producers and consumers must never silently coerce an unknown version to v1.

### Coordinated component versioning

Development branches use `V<framework>.<component>.<patch>`. The first number is the shared Sidecar↔Watchdog coordination/framework compatibility generation; the second is the individual component version within that framework; the third is that component version's patch. The shared framework number changes only for a coordinated framework/contract generation change, while component minor/patch numbers may advance independently. Branch names include the date as `feat/v<version>-YYYYMMDD-<scope>`. This refactor starts both components at `V1.0.1`.

## Observation v1

Observation payloads are source-specific facts and are not directly sendable commands.

The v1 envelope has a fixed top-level shape. Unknown facts use `null` or the `unknown` enum value; producers do not add source-specific top-level fields.

```json
{
  "contractVersion": 1,
  "source": "browser|ledger|receipt|watchdog|human",
  "conversationId": "conv_...",
  "target": "https://chatgpt.com/.../c/<uuid>",
  "observedAt": "ISO-8601",
  "turnId": "turn_...|null",
  "userMessageId": "...|null",
  "assistantMessageId": "...|null",
  "assistantText": "...|null",
  "readable": true,
  "generating": "true|false|null",
  "terminal": "true|false|null",
  "body": "unknown|empty|incomplete|substantive",
  "humanGate": "true|false|null",
  "delivery": "unknown|none|pending|delivered|uncertain",
  "requestId": "...|null"
}
```

`assistantText` is the exact assistant body text associated with `assistantMessageId` when readable; it is evidence payload, not by itself completion proof. Observation producers must not emit the authoritative state version. Unknown or extra top-level fields fail closed in v1. `assistantText` is observation evidence, not intent text: `null` means unavailable/absent, an empty string is valid readable evidence, and v1 bounds non-null text independently at 1,000,000 characters so long valid assistant results do not become UNKNOWN merely because they exceed the prompt-size bound.

## ConversationState v1

State is deliberately multi-dimensional. Do not collapse unrelated facts into one overloaded phase.

```json
{
  "contractVersion": 1,
  "conversationId": "conv_...",
  "target": "https://chatgpt.com/.../c/<uuid>",
  "stateVersion": 42,
  "turn": {
    "turnId": "turn_...|null",
    "userMessageId": "...|null",
    "assistantMessageId": "...|null"
  },
  "progress": "idle|active|blocked|terminal|unknown",
  "body": "unknown|empty|incomplete|substantive",
  "delivery": "none|pending|delivered|uncertain",
  "gate": "none|human_required",
  "writer": {
    "mode": "managed|legacy",
    "epoch": 7
  }
}
```

### State semantics

- `progress=active`: the exact current turn is still generating/responding.
- `progress=blocked`: generation stopped but the exact turn is not valid terminal output and no human gate is asserted.
- `progress=terminal`: exact-turn terminal evidence and body contract are satisfied.
- `progress=unknown`: evidence is insufficient or unreadable; never treat as idle/terminal.
- `body=substantive`: body-completeness contract is satisfied.
- `gate=human_required`: sticky automation veto until explicit human provenance clears it.
- `delivery=uncertain`: send outcome cannot be proven; it is not equivalent to failed.

`stateVersion` is monotonic per logical conversation and changes whenever any authoritative state dimension changes. Reduction/persistence is serialized per logical conversation so two concurrent observations cannot produce different authoritative meanings with the same state version.

### Authoritative state read boundary

Managed consumers read state through Sidecar's localhost-only `POST /internal/conversation-state` endpoint with the strict body `{ "target": "<exact ChatGPT conversation URL>" }`. The endpoint rejects browser `Origin`, does not appear as an MCP/model-facing tool, resolves exactly one local conversation binding, and delegates to the same authoritative reducer. Missing or ambiguous bindings fail closed rather than selecting a conversation heuristically.

## IntentEnvelope v1

```json
{
  "contractVersion": 1,
  "intentId": "stable-id",
  "source": "human|watchdog|coordinator",
  "conversationId": "conv_...|null",
  "target": "https://chatgpt.com/.../c/<uuid>|null",
  "expectedStateVersion": 42,
  "expectedWriterEpoch": 7,
  "action": "continue|open_child|stop",
  "allocation": "NEW|REUSE|null",
  "text": "...|null",
  "expected": {
    "userMessageId": "...|null",
    "assistantMessageId": "...|null"
  }
}
```

### Intent invariants

1. `intentId` is stable across retries of the same logical request.
2. `expectedStateVersion` and `expectedWriterEpoch` are mandatory for state-changing actions against an existing conversation.
3. A stale state version or writer epoch is rejected before pacing or browser mutation.
4. `action=open_child` requires `allocation=NEW|REUSE`; other actions require `allocation=null`.
5. `REUSE` requires an explicit target/conversation identity. Sidecar never chooses it implicitly.
6. `NEW` must not silently attach to an existing child as logical reuse; any existing thread used only as a browser navigation seed is transport detail.
7. Unknown/unsupported actions or extra fields fail closed.

## Control plane

Control-plane data is not ordinary message content:

- writer mode
- writer epoch
- ownership/lease
- human gate
- extension lifecycle/reload admission
- global pacing reservation

A mode or epoch change invalidates intents issued against the old writer epoch. In the Runtime Home deployment, each new Sidecar writer server incarnation claims the next durable epoch from `data/writer-authority.json` **and holds the corresponding process-lifetime lease until that server closes or dies**. A second live writer cannot advance the epoch; a replacement may fence an orphan only after proving the recorded owner PID is dead. Before listening on the managed HTTP endpoint, the new writer must durably claim the same epoch at the Extension Effect Sink. Every Sidecar browser-mutation command carries that epoch, and the Extension revalidates it at effect execution. The Extension epoch claim is a barrier: it waits for already-running writer commands to drain, prevents later commands from entering until the claim is durable, and then rejects stale-epoch commands before browser mutation. The epoch is not a release number, wall-clock guess, or constant default. Source-only/test hosts without a stable data root may use explicit epoch `0`, but production Runtime Home must not. Legacy direct mode cannot share managed writer authority for the same browser session.

## Reducer rules

The reducer consumes ledger state plus fresh observations and receipts.

Rules required by current failures:

1. `ledger=generating` plus live exact-turn `generating=false` cannot be returned unchanged without reconciliation.
2. A stopped page with only shell/title/insubstantial assistant body reduces to `progress=blocked`, not `terminal`.
3. `EffectReceipt` proves delivery identity only; it cannot prove assistant completion.
4. A missing/unreadable live observation reduces to `unknown`, never `terminal` or retryable failure.
5. Terminal/body evidence must be bound to the exact current user/assistant identities.
6. Reducer output is durably reflected in Sidecar state before policy/dispatch consumes it.
7. A newer user turn after the expected user identity makes that observation unreadable for the old turn; later assistant output cannot be rebound backward.
8. `Continue generating` / interrupted generation is nonterminal even when the partial body is substantive.
9. `human_required` is a sticky control-plane veto and is never cleared merely because a browser observation reports no gate on a later poll.
10. A late or repeated `EffectReceipt` is evidence for its exact `(requestId, conversationId, turnId)` only. It cannot acquire state authority for a newer turn or writer epoch, cannot roll back terminal/blocked state, and cannot advance `stateVersion` when authoritative semantics are unchanged.

## Watchdog migration

Watchdog keeps browser/Relay observation only as an input provider during transition. Its policy must ultimately consume Sidecar `ConversationState`, not independently own a competing conversation lifecycle.

Target managed loop:

`read authoritative state -> policy -> publish IntentEnvelope -> wait for new state`

Watchdog may keep local dedupe bookkeeping, but local `Phase` cannot overrule Sidecar state.

During migration, the legacy `conversation_read()` completed-state live snapshot path remains only as a backward-compatibility read surface. It is not an authoritative policy or dispatch input. Watchdog, Sidebar policy, and the versioned dispatcher must consume `ConversationStateV1` through the authoritative state owner boundary; the legacy fallback is removed only after those consumers have migrated and acceptance tests pass.

## Sidebar/browser migration

The Extension/content script becomes:

- observation provider
- browser command executor
- durable effect-receipt recorder

Sidebar UI becomes:

- state subscriber
- human intent producer

Project/tab discovery and browser attachment remain transport concerns. They cannot decide logical reuse or task completion.

## Dispatcher migration

Existing Sidecar mailbox remains the single browser-write serialization boundary.

Before irreversible send:

`claim intent -> pacing -> re-read authoritative state -> verify stateVersion/epoch/identities/gates -> reserve effect -> browser command`

No meaningful wait may occur between final state validation and browser command without another validation.

## Failure semantics

- Observation unavailable -> `unknown`; no automatic state-changing intent is dispatched.
- Stale intent -> reject with `stale_state` including current state version.
- Delivery uncertain -> preserve existing fail-closed receipt reconciliation behavior.
- Human gate -> reject automation intents until explicit human provenance clears it.
- Producer unavailable -> other independent producers may continue; one producer must not own global runtime liveness.

## Migration slices

1. Shared v1 schemas + fixtures + validators only. No behavior change.
2. Sidecar authoritative reducer/projection; repair stale `generating` by exact live evidence.
3. Watchdog consumes authoritative state for policy; Relay remains observation provider only.
4. Sidecar dispatcher accepts versioned intents from Watchdog/Coordinator/Sidebar adapters.
5. Sidebar/Extension responsibilities split into state subscriber/human intent producer versus browser driver.
6. Explicit NEW/REUSE execution path and lifecycle tests; AUTO remains unsupported.
7. Delete duplicate local state authority only after all cross-project acceptance tests pass.

## Cross-project acceptance invariants

- The same fixtures validate in Node and Python.
- A Watchdog intent generated from state version N is rejected if Sidecar reaches N+1 before dispatch.
- `generating` ledger + stopped incomplete DOM converges to `blocked` once, durably, without sending.
- `generating` ledger + exact valid terminal body converges to `terminal` once, durably, without sending.
- Sidebar, Watchdog, and Coordinator cannot independently mutate the browser.
- One producer being blocked/unknown does not globally freeze unrelated conversations.
- NEW and REUSE are user/policy intent fields, never transport heuristics.

## Rollout

Each slice is independently committed and reviewed. Sidecar is deployed before the corresponding Watchdog consumer change when the new contract is backward-compatible. No production browser crash injection is required; destructive failure points stay in isolated tests. The installed Runtime Home and installed Watchdog venv remain deployment authorities and must be re-verified after each rollout slice.
