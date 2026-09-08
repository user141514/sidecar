# ChatGPT conversation extension: verified local updates

This checkout ships the Chrome extension, native host, CLI, MCP tools, Skill and Linux/Windows installation adapter together. Node 24+ is required. There is no dependency on Orca or a second Sidecar checkout. The standalone provider excludes work/controller/memory business logic.

## Installation (Linux and Windows)

From the intended checkout:

```text
npm link
npm run install:host
```

`npm link` creates the platform-appropriate command shim for `chatgpt-conversation`; all command semantics are in the same `src/cli.mjs`. On Windows the native installer registers both Chrome and Edge -> manifest -> launcher. Only `install/platform-link.mjs` plus the POSIX/Windows launcher differ by OS. Registration selects ONE installation for the fixed extension ID; do not register Sidecar and standalone on top of one another unintentionally.

For Agent Runtime installs, bootstrap publishes the verified release extension at the stable Runtime Home path `extension-current/`. Load that stable directory once using Chrome or Edge's unpacked-extension UI; do not load `releases/<sha>/extension`, because that binds browser trust to one immutable release. After the one-time trust action, later bootstrap upgrades replace `extension-current/` from a verified release while keeping the browser source path stable, and `chatgpt-conversation extension-update` reloads the already-trusted extension to activate the new bytes. When upgrading an older installation that was originally loaded from a checkout or `releases/<sha>/extension`, one final manual migration to `extension-current/` is required. Do not use CDP, direct profile edits, or remote-debugging permissions to bypass that trust boundary.

## Updating an existing installation

First fetch/review source through the approved Git SSH remote workflow. The update command does not download arbitrary executable code and does not perform an implicit git pull. For Agent Runtime, run bootstrap first so the new verified release is published into the stable `extension-current/` path, then reload that same trusted path.

```text
npm run extension:build
npm test
npm run bootstrap -- --activate
chatgpt-conversation extension-status
chatgpt-conversation extension-update
```

`extension-reload` is an alias for `extension-update`. Optional `--timeout-ms N` accepts 100–300000; default 60000. This timeout bounds the updater's reconnect verification; it is NOT a worker generation deadline. `npm run extension:check` detects stale generated build metadata without changing files.

The CLI refuses reload when the extension has pending turns, unacknowledged terminal outbox records or in-flight browser operations. There is no `--force`. Do not delete pending records merely to permit an update. A failed update prints a nonzero exit status and must not be reported as success.

## What success proves

The extension saves a reload receipt, posts an acknowledgement and schedules `chrome.runtime.reload()`. Its old native host may exit with the old connection. The separate CLI then polls the local endpoint until it observes all of:

- a new extension instance ID;
- the same fixed extension ID;
- the exact request receipt tied to the previous instance;
- the locally expected SHA-256 build fingerprint;
- successful managed content-script restoration.

No browser window or tab is opened, activated, navigated or reloaded by this update path. Only existing tabs whose URL still matches their durable managed binding can receive the bundled `build-info.js` and `content-script.js`. Closed/repurposed tabs are skipped and reported. Reinjection replaces the old content listener and stops disposed observers without emitting fake terminal events. Unmanaged tabs are untouched.

Build IDs cover extension manifest, service worker, content script and lifecycle code, with CRLF normalized to LF. They identify source content, not just a version label. The ID is captured when scripts execute; changing disk files alone does not change the running ID.

`extension_status` and `extension_reload` are shared MCP tools. The latter reports acceptance only. Use the independent CLI to obtain `verified: true`; a server that is itself exiting cannot prove its own replacement.

## Source and distribution ownership

The integrated Sidecar and standalone provider use identical extension files, CLI, provider host/store, Native Messaging, provider MCP descriptors, Skill and platform adapter. Run `npm run build:provider` from Sidecar to create a fresh `dist/chatgpt-conversation/` distribution. Export refuses an existing destination, copies an explicit allowlist, excludes data/secrets/.git and includes provenance/build identity. Run its tests from inside that distribution before publishing it to the separately confirmed SSH repository.

The two distributions serve different roles: Sidecar additionally contains work/controller/memory APIs; standalone exposes only the eight shared conversation/project/extension tools. Linux and Windows within either distribution use the SAME branch and shared protocol. No Windows-specific extension or Skill fork is maintained.

## Verification boundary

Unit/HTTP integration tests exercise idle admission, storage failure, correlated restart verification, lost ACK, stale instance/build, idempotent reinjection, exact-tab restoration and isolated packaging. CI is configured for Node 24 on Ubuntu and Windows. This configuration and Linux-hosted Windows fixtures do not constitute a completed Windows Chrome live test. Record actual platform execution separately.

Chrome API references:
- https://developer.chrome.com/docs/extensions/reference/api/runtime
- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- https://developer.chrome.com/docs/extensions/reference/api/scripting
