# Global Send Admission Design

## Goal

Enforce the user-required minimum 120-second interval at one owning boundary for managed Sidecar sends and Watchdog direct continuations, including across Sidecar restarts.

## Ownership

Sidecar already owns ChatGPT conversation transport. Its existing localhost server owns admission. Watchdog decides whether continuation is needed; it does not own pacing state.

No new daemon, capability registry, task database, or shared writable file between Sidecar and Watchdog is introduced.

## Contract

A small durable `SendAdmission` record lives under the existing Sidecar data root. It records the most recent granted send admission and survives server restart. Admission is serialized by the Sidecar process.

`admit(source, target)` returns either:
- `admitted: true` with the grant time; or
- `admitted: false` with `retryAfterMs`.

A grant is consumed even if the later browser send fails. This is conservative and preserves the spacing invariant.

Sidecar manual `conversation_send` uses this admission automatically. `WorkController` asks the same owner after validating the frontier but before creating a new conversation, then performs its send as pre-admitted. Its existing local pacing remains only a conservative compatibility precheck, not the system authority.

The existing Sidecar HTTP server exposes a localhost-only internal admission endpoint for Watchdog. This endpoint is not an MCP/model-facing tool.

When Watchdog is configured with the admission endpoint, direct continuation must obtain a grant before DOM submission. Denial or admission-service failure is fail-closed and must not fall through to an unadmitted recovery send. Legacy standalone Watchdog without an admission endpoint retains its existing behavior but makes no global-spacing claim.

## Invariants

1. The durable Sidecar admission record is the sole authority for the managed 120-second spacing contract.
2. No caller can turn admission denial into a send by switching to another normal send path.
3. A Sidecar restart does not reset the spacing window.
4. Admission state is pacing state only; it does not become task/completion authority.
5. Exact conversation identity remains owned by the existing Sidecar/Watchdog identity contracts.

## Deferred boundary

Hard-bound recovery-agent continuation is a later task. Until then, managed Watchdog mode with shared admission must fail closed rather than launch a recovery path that could send outside the admission owner.
