# Conversation Worker Contract Design

Date: 2026-09-12
Status: Approved for implementation

## Problem

The system currently overloads `subagent` across multiple execution backends. In particular, the Sidecar managed ChatGPT child-conversation path and DevSpace local provider workers can both match natural-language requests such as "start a subagent". On Windows, Sidecar also installs only `.cmd` user shims, so Git Bash can discover DevSpace's local-agent CLI more easily than the correct Sidecar CLI.

This is both a semantic-routing bug and an executable-discovery bug. Prompt-only preference rules are insufficient because the wrong backend remains a valid-looking and easier-to-call alternative.

## Shared worker taxonomy

`subagent` is a role, not a backend. Model-visible and machine-readable contracts distinguish concrete worker kinds:

- `conversation_worker`: a physical ChatGPT child conversation managed by Sidecar/WorkController.
- `host_worker`: a local worker executed by DevSpace on the current host.
- `orca_worker`: an Orca-managed worker/worktree mission.

This repository owns only `conversation_worker` behavior. It must not create or describe DevSpace host workers or Orca workers.

## Sidecar public contract

### Skill identity

The canonical model-visible Skill name becomes `conversation-workers`.

For migration safety, the tracked package directory and installed directory may remain `chatgpt-subagents`; directory names are compatibility implementation details. Bootstrap must accept an existing managed legacy `chatgpt-subagents` Skill and replace its contents in place with the canonical `conversation-workers` Skill. It must not install both names simultaneously.

The Skill description must explicitly state that it creates managed ChatGPT child conversations and must not be used for DevSpace local Codex/Claude/Pi workers or Orca workers.

### Dispatch receipts and ledger evidence

Every WorkController dispatch result must identify the intended worker route even when dispatch is paced:

```json
{
  "worker_kind": "conversation_worker",
  "backend": "sidecar"
}
```

Successful/uncertain `worker_dispatched` ledger events and terminal `worker_result` events must carry the same fields. Derived frontier state must preserve those fields. Existing `frontierId`, `conversationId`, `turnId`, and other fields remain unchanged for compatibility.

These fields are evidence for Watchdog/Lifetime routing. They are not authorization to create work.

### Windows shell parity

A bootstrapped Windows installation must expose both forms for each user command in the roaming npm command directory:

- `chatgpt-conversation` and `chatgpt-conversation.cmd`
- `conversation-work` and `conversation-work.cmd`

The extensionless files are POSIX shell shims for Git Bash/MSYS and forward to the stable Runtime Home extensionless launcher. The `.cmd` files continue to serve CMD/PowerShell-compatible command resolution. Both forms must be classified for foreign-entrypoint conflicts before any managed file is written.

Linux behavior remains unchanged.

## Invariants

1. Managed conversation dispatch always uses `WorkController` and the configured canonical `subagents` ChatGPT Project; unresolved Project identity fails closed.
2. `worker_kind=conversation_worker` never means a local provider process.
3. Bootstrap installs one model-visible Sidecar Skill, not legacy and canonical duplicates.
4. Windows CMD/PowerShell and Git Bash resolve the same logical Sidecar commands.
5. Existing work IDs, conversation IDs, turn IDs, event types, and internal controller behavior remain backward compatible.

## Tests

- Skill migration test: canonical frontmatter is installed in the legacy-compatible directory and legacy managed frontmatter is accepted for replacement.
- WorkController tests: paced, successful, uncertain, and collected result paths expose/persist `worker_kind=conversation_worker` and `backend=sidecar`.
- Windows installer tests: both extensionless and `.cmd` shims are emitted, reported in installer results, conflict-checked, and idempotent.
- Windows Git Bash live fixture: invoke the extensionless installed shim through Git Bash and prove it reaches the stable Runtime Home launcher.
- Full Sidecar test suite and runtime/package verification remain green.
