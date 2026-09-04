# Execution-History-Conditioned Plan Revision V1

## Goal

Build the smallest usable baseline where the current host LLM can revise the active plan from execution history, then let routing/decomposition/delegation operate under the revised plan.

This V1 intentionally uses only the current work trajectory. It does not use historical cross-task memory, embeddings, learned routers, RL, GNNs, or task-complexity scoring.

## Model

At time `t`:

```text
H_t = current Work Ledger history
P_t = current explicit plan snapshot
O_t = current orchestration mode
```

The host LLM may produce:

```text
REVISE(H_t, P_t, O_t) -> (P_t+1, O_t+1)
```

Then ordinary control actions operate under the revised plan:

```text
CONTINUE | SPLIT | PRUNE | STOP
```

The plan is the primary mutable object. Frontiers and worker allocation are downstream execution structures, not the plan itself.

## Plan Revision Decision

`work_decide` gains one new action: `REVISE`.

```json
{
  "action": "REVISE",
  "reason": "New execution evidence invalidated the current approach.",
  "evidence_event_indexes": [4, 7],
  "plan": {
    "objective": "Resolve the current goal with the best-supported route.",
    "approach": "Stop broad exploration and compare the two surviving hypotheses.",
    "current_focus": "Determine which hypothesis explains the observed failure.",
    "assumptions": ["Identity is already stable."],
    "open_questions": ["Which lifecycle transition invalidates the binding?"]
  },
  "orchestration": {
    "mode": "ADVERSARIAL"
  }
}
```

### Orchestration modes

V1 exposes only four semantic modes:

- `EXPLORE` — discover the problem/solution space and gather evidence.
- `EXECUTE` — carry out the current plan and verify concrete progress.
- `ADVERSARIAL` — compare, attack, falsify, or review competing hypotheses/solutions.
- `SYNTHESIZE` — consolidate evidence, research results, and conclusions.

Monitoring is not a mode. Collection/observation can happen in any mode.

## Plan Snapshot

The snapshot is deliberately small:

```text
objective: string
approach: string
current_focus: string
assumptions: string[]
open_questions: string[]
```

The controller derives a monotonically increasing `version` from accepted `REVISE` events. The host does not provide version numbers.

## Evidence Link

Every `REVISE` must include at least one `evidence_event_indexes` entry.

Indexes refer to the append-only `events` array returned by `work_state`. They are stable because the ledger is append-only.

The controller rejects indexes that are negative, duplicated, non-integer, or outside the current event history. This is the minimal causal link needed for later baseline analysis:

```text
history event(s) -> plan revision -> later orchestration/outcome
```

No inferred branch utility or information-gain score is stored.

## Derived Work State

`work_state` additionally returns:

```text
currentPlan
currentOrchestration
planHistory[]
```

Each `planHistory` item contains:

```text
version
at
reason
evidence_event_indexes
plan
orchestration
```

Existing fields such as `frontiers`, `latestDecision`, `completed`, `stopped`, and raw `events` remain available.

## Interaction With Routing

`REVISE` does not implicitly mutate the task graph.

After a plan change, the host explicitly decides what to do with existing work:

```text
REVISE
  -> PRUNE obsolete frontiers if needed
  -> SPLIT new frontiers if needed
  -> CONTINUE if the current frontier set is still valid
```

This separation is intentional because it makes the data attributable: plan revision and task-graph mutation are distinct decisions.

## Worker Context

When a frontier is dispatched, the depth-1 worker prompt includes the current plan snapshot and orchestration mode when one exists. Therefore plan revision has a concrete downstream effect on delegated execution.

Workers still cannot create or dispatch workers. They only return results/evidence/unresolved frontiers to the coordinator.

## Invariants

1. The original Work Ledger goal remains the durable top-level goal; a plan may revise approach/focus but cannot silently rewrite the user goal.
2. `REVISE` is accepted only with a complete plan snapshot, one valid orchestration mode, and at least one valid evidence reference.
3. Plan versions are derived from event order and cannot be supplied or rewritten by the host.
4. Existing `CONTINUE/SPLIT/PRUNE/STOP` behavior remains valid for legacy ledgers without a plan snapshot.
5. `STOP`/`completed` remains terminal for further decisions/dispatch.
6. Physical delegation depth stays 1; only the coordinator can dispatch.
7. Dispatch remains dependency-gated and globally serialized in-process with a 120-second minimum interval.
8. Cross-task historical memory is out of scope for V1.

## Baseline Data

A useful V1 run produces records equivalent to:

```text
H_t
P_t
REVISE(reason, evidence_event_indexes)
P_t+1
orchestration_mode_t+1
SPLIT/PRUNE/CONTINUE decisions
worker results
final outcome
```

This is the baseline dataset needed before testing whether historical cross-task memory improves plan-revision timing or quality.

## Non-Goals

V1 does not add:

- memory retrieval or a memory pool policy;
- learned routing/planning models;
- automatic plan generation inside the sidecar;
- numeric utility/confidence/information-gain fields;
- recursive worker spawning;
- implicit deletion/rewrite of old ledger events;
- automatic concurrent fanout.
