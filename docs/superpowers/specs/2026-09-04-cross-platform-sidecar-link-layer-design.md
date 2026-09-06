# Cross-Platform Sidecar Link Layer Design

## Goal

Make one Sidecar commit install and start correctly on both Linux and Windows while keeping the browser protocol, MCP schema, Work Ledger, controller, memory pool, checkpoint semantics, and Skill policy shared.

## Problem

The current Linux branch hard-codes one Linux Native Messaging manifest path and launches `src/server.mjs` directly from that generated/static manifest. The Windows branch proved a different installation boundary: Chrome expects a registry entry that points to a manifest, and the native host launcher must be a `.bat` file that preserves stdio. The Windows branch also contains unrelated shared feature drift (`mcp-client`, `mcp-cli`, `mcp-stdio` hardening, and current uncommitted ChatGPT app-selection support). Those must not be conflated with OS-specific behavior.

## Boundary

The platform-specific layer is deliberately limited to Native Messaging installation and process launch:

```text
shared Sidecar runtime
  src/server.mjs
  src/chatgpt.mjs
  src/store.mjs
  src/native-messaging.mjs
  src/work-*.mjs
  src/memory-pool.mjs
  extension/*
        |
        v
install/install-host.mjs
  Linux -> ~/.config/google-chrome/NativeMessagingHosts/<host>.json
           -> install/conversation-sidecar-host
  Windows -> %USERPROFILE%/AppData/Local/Conversation Sidecar/NativeMessagingHosts/<host>.json
           -> HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<host>
           -> install/conversation-sidecar-host.bat
```

No platform abstraction is added to WorkController, MemoryPool, MCP dispatch, the extension, or Skill policy.

## Invariants

1. Native Messaging host name remains `com.conversation_sidecar.host`.
2. Extension origin remains `chrome-extension://cfifihieaffhniimpimnfmignbbdaalb/`.
3. The generated manifest always uses an absolute launcher path.
4. Linux registration is filesystem-only under the current user Chrome config directory.
5. Windows registration is current-user only under HKCU and points to a manifest under `%USERPROFILE%/AppData/Local`, not `LOCALAPPDATA`.
6. The Windows launcher must preserve Chrome's stdin/stdout connection; it must not use `start` or spawn a detached process.
7. The POSIX launcher must `exec node .../src/server.mjs` so Chrome owns the same process lifecycle.
8. The same `src/server.mjs` is launched on both operating systems.
9. Server direct-entry detection must be path-safe on Windows.
10. No current Work/Memory/Router behavior changes in this migration.

## Files

### New

- `install/install-host.mjs` — single Node installer containing the only OS branch.
- `install/conversation-sidecar-host` — POSIX stdio launcher.
- `install/conversation-sidecar-host.bat` — Windows stdio launcher.
- `install/install-host-win.bat` — minimal cmd convenience wrapper around the shared Node installer.
- `test/native-host-installer.test.mjs` — simulated Linux and Windows installation contract.
- `test/windows-runtime.test.mjs` — Windows launcher/direct-runtime contract.

### Changed

- `src/server.mjs` — use `fileURLToPath(import.meta.url)` for direct-entry comparison.
- `package.json` — add one cross-platform `install:host` script.
- `README.md` — document the shared runtime and two thin installation edges.

### Removed

- `install/com.conversation_sidecar.host.json` — hard-coded machine-local Linux manifest.

## Explicit Non-Goals

- Do not merge Windows branch `mcp-client.mjs` or `mcp-cli.mjs` in this task.
- Do not merge current Windows uncommitted ChatGPT `--app` support.
- Do not add `sidecar doctor`, service management, auto-restart, or a general platform class.
- Do not change the extension ID or Native Messaging host identity.
- Do not modify the dirty Windows checkout.
- Do not merge to `main` until the unified commit has been verified on an isolated Windows worktree.

## Verification

Linux host:

1. Unit-test Linux and Windows manifest generation using injected paths/registration.
2. Run the full repository suite.
3. Run `git diff --check`.
4. Generate a manifest into a temporary directory and verify the POSIX launcher path.

Windows host, isolated worktree:

1. Run the same full test suite.
2. Verify `.bat` launcher tests and direct `src/server.mjs` startup test execute on win32.
3. Optionally run the real HKCU registration test only with an explicit environment gate; never mutate the user's existing dirty Windows checkout.

Success means one commit passes both hosts without conditional application-code forks.