# Low-Frequency Historical Memory Pool V1 Design

## Goal

Add a deliberately coarse local historical-memory pool over completed Work Ledgers while preserving a clean distinction between:

- online current-task trajectory (`data/works/...`) — high-frequency mutable-by-append state;
- historical memory (`data/memory/...`) — low-frequency explicitly published immutable snapshots.

V1 exists to generate a trustworthy baseline and future paper dataset, not to maximize retrieval quality.

## Core Invariants

1. Work Ledger remains the online source of truth.
2. Memory publication is explicit and slow. No work event, completion hook, query, collect, or revision auto-publishes memory.
3. Only a work whose final event is `completed` and whose prior decisions include `STOP` may be published.
4. A published memory record is immutable. Corrections require a new work and a new memory record; existing records are never updated in place.
5. Publishing copies the source trajectory by value through the terminal completed event. Memory never references the live source file for later reads.
6. Query is deterministic and deliberately dumb: optional literal case-sensitive substring filtering only, no ranking, embeddings, similarity score, recency boost, top-k, or query rewriting.
7. Query availability and actual consumption are separate facts and are both persisted in the current Work Ledger.
8. Historical memory is never implicitly injected into plan revision or worker prompts. A coordinator must explicitly query and consume a record before using it.
9. Existing `REVISE.evidence_event_indexes` remains the causal evidence mechanism. A plan revision that uses historical memory cites the `memory_consumed` event index in the current Work Ledger.
10. Workers cannot publish/query/read the pool autonomously through the orchestration protocol; the coordinator owns memory use.

## Filesystem Layout

```text
data/memory/
  manifest.jsonl
  records/
    mem_<uuid>/
      meta.json
      events.jsonl
```

`manifest.jsonl` is append-only. Each line is one published immutable record:

```json
{
  "pool_revision": 1,
  "memory_id": "mem_<uuid>",
  "source_work_id": "work_<uuid>",
  "published_at": "2026-09-04T00:00:00.000Z",
  "source_completed_event_index": 17,
  "source_events_sha256": "...",
  "record_sha256": "..."
}
```

`records/<memory_id>/meta.json` contains the same provenance plus `schema_version: 1`.

`events.jsonl` contains the canonical copied trajectory through the terminal `completed` event. Event index zero remains the first line, preserving `REVISE.evidence_event_indexes` semantics.

A publish becomes visible only after the record files are complete and the manifest line is appended. Orphaned record directories are invisible to queries.

## Publication

API:

```text
work_memory_publish { source_work_id }
```

Validation:

- source work exists;
- final event is `completed`;
- a `STOP` decision exists before completion;
- no event exists after completion;
- duplicate publication of the exact same terminal source snapshot is idempotent and returns the already-published record rather than creating a duplicate.

The publisher computes:

- `source_events_sha256` from canonical copied event JSONL bytes;
- `record_sha256` from canonical metadata-without-record-hash plus copied event bytes;
- `pool_revision` as the next manifest revision in the single sidecar process.

Publication never modifies the source Work Ledger.

## Query

API:

```text
work_memory_query { work_id, contains? }
```

Semantics:

- freeze the current manifest snapshot;
- enumerate records in manifest order;
- if `contains` is present, match it as a literal case-sensitive substring against the copied canonical `events.jsonl` bytes;
- no ranking or truncation;
- return all matches.

The query appends one `memory_query` event to the current work:

```json
{
  "retrieval_id": "retrieval_<uuid>",
  "pool_revision": 12,
  "manifest_sha256": "...",
  "query": {"contains":"completion"},
  "available": [
    {"memory_id":"mem_a","source_work_id":"work_a","record_sha256":"..."}
  ],
  "matched": [
    {"memory_id":"mem_a","source_work_id":"work_a","record_sha256":"..."}
  ]
}
```

The returned preview may additionally include derived convenience fields `goal` and terminal `outcome`; they are not authoritative persisted memory fields.

A zero-match query is still logged.

## Explicit Consumption

API:

```text
work_memory_read { work_id, retrieval_id, memory_id }
```

Validation:

- `retrieval_id` must exist in a prior `memory_query` event in the same current work;
- `memory_id` must be in that query's `matched` set;
- the immutable record's current content hash must equal the recorded `record_sha256`.

On success it appends:

```json
{
  "type": "memory_consumed",
  "payload": {
    "retrieval_id": "retrieval_x",
    "memory_id": "mem_a",
    "source_work_id": "work_a",
    "record_sha256": "..."
  }
}
```

and returns the immutable `meta` plus full copied events.

This separates:

```text
available corpus -> matched records -> actually consumed records -> later REVISE evidence
```

## Work Ledger Extension

Add internal event types:

```text
memory_query
memory_consumed
```

They may be appended by MemoryPool operations only. The public generic `work_append` surface must continue to reject them.

## MCP / CLI Surface

Add only:

```text
work_memory_publish
work_memory_query
work_memory_read
```

CLI:

```text
conversation-work memory-publish <source_work_id>
conversation-work memory-query <work_id> <query_json>
conversation-work memory-read <work_id> <retrieval_id> <memory_id>
```

No update, delete, list, score, similar, summarize, auto-publish, or auto-use command in V1.

## Skill Behavior

`dynamic-work-router` keeps current-trajectory-only behavior as the default baseline.

Historical memory is optional and explicit:

1. coordinator chooses to query;
2. query is logged;
3. coordinator chooses which matched record to read;
4. consumption is logged;
5. later `REVISE` may cite that `memory_consumed` event index.

The skill must never require memory use for every task.

## Deferred

- embeddings / vector database;
- BM25 or any ranking;
- learned router or memory scorer;
- automatic summarization or extraction;
- auto-promotion on completion;
- memory utility labels;
- deduplication beyond exact terminal-snapshot idempotency;
- retention / eviction;
- cross-memory synthesis;
- worker-side autonomous retrieval.
