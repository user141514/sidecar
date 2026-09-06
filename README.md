# sidecar

Cross-platform local sidecar for durable ChatGPT browser conversations, Work Ledger state, plan revision, historical memory, checkpoints, and bounded worker coordination. Linux and Windows share one application runtime; OS differences are confined to Native Messaging installation and launch.

## Runtime

```text
MCP / Skill / host LLM
  -> sidecar localhost MCP + durable Work state
  -> ChatGPT conversation provider / bounded workers
  -> Chrome Native Messaging
  -> installed Manifest V3 extension
  -> existing signed-in ChatGPT profile
```

The operational browser path does **not** use an externally exposed CDP port, `DevToolsActivePort`, Playwright, Puppeteer, cookie copying, or a second browser profile.

## One-time installation boundary

The application runtime and browser protocol are shared on Linux and Windows. Only Native Messaging registration and the tiny launcher differ by operating system.

From the checkout on either platform, register the native host with:

```bash
npm run install:host
```

The installer generates a user-local manifest containing an absolute launcher path. Re-run it after moving the checkout.

### Linux

The generated manifest is:

```text
~/.config/google-chrome/NativeMessagingHosts/com.conversation_sidecar.host.json
```

It launches:

```text
<checkout>/install/conversation-sidecar-host
```

The POSIX launcher `exec`s the shared `src/server.mjs` so Chrome owns the same stdin/stdout process lifecycle.

### Windows

The same installer generates:

```text
%USERPROFILE%\AppData\Local\Conversation Sidecar\NativeMessagingHosts\com.conversation_sidecar.host.json
```

and registers that manifest path for the current user under:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.conversation_sidecar.host
```

The manifest launches:

```text
<checkout>\install\conversation-sidecar-host.bat
```

which delegates Chrome stdin/stdout directly to `node.exe <checkout>\src\server.mjs`. For cmd users, `install\install-host-win.bat` is a thin wrapper around the same Node installer.

Node.js 24+ must be visible as `node` / `node.exe` to Chrome's user environment.

### Shared Chrome trust action

1. Open `chrome://extensions` in the existing signed-in Google Chrome profile.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `<checkout>/extension` (or `<checkout>\extension` on Windows).

Expected fixed extension ID:

```text
cfifihieaffhniimpimnfmignbbdaalb
```

The Native Messaging host identity also remains shared:

```text
com.conversation_sidecar.host
```

After this one installation, Chrome persists the extension. When it starts, it connects to the Native Messaging host, which launches the same `src/server.mjs` on both operating systems. No recurring browser approval is introduced.

## Verified extension self-update

Both Linux and Windows use the same CLI and MCP update protocol:

```text
npm link
npm run extension:build
npm test
chatgpt-conversation extension-status
chatgpt-conversation extension-update
```

An old installation without the update handler needs one manual bootstrap reload. Later updates use the extension's own reload API, never browser UI automation. Pending turns, undelivered terminal events and concurrent browser mutations block reload. The independent CLI survives native-host replacement and verifies a correlated receipt, new instance, exact build and managed content-script restoration. `extension-reload` is an alias. Source download/review remains an explicit Git SSH operation, not an implicit network updater.

See [update and installation contract](docs/extension-update.md). The tracked Skill is `skills/chatgpt-subagents/SKILL.md`. `npm run build:provider` exports a self-contained provider with the same extension, CLI, schemas, Skill and link adapter, excluding work/controller/memory. Export refuses an existing destination.

## Browser placement

The first `conversation_create` establishes one sidecar-owned normal Chrome window, `window0`, using the existing signed-in profile. That first conversation uses window0's initial tab. Every later `conversation_create` uses `chrome.tabs.create({ windowId: window0 })`; it must not create another Chrome window. If the user closes window0, the next create establishes a replacement window0.

## MCP surface

The repository currently contains both the replaceable ChatGPT conversation provider and the integrated control-plane primitives used during rapid single-developer iteration.

Provider tools include:

- `project_create`, `project_find`, `project_pin`
- `conversation_create`, `conversation_send`, `conversation_read`
- `extension_status`, `extension_reload` (acceptance only; use CLI for verified updates)

Control tools include:

- `work_create`, `work_append`, `work_read`, `work_state`
- `work_decide`, `work_checkpoint`
- `work_dispatch`, `work_collect`
- `work_memory_publish`, `work_memory_query`, `work_memory_read`

The semantic routing policy remains outside the runtime in Agent Skills. The deterministic runtime owns durable state, validation, pacing, provenance, and bounded execution effects.

A Project home URL has the form:

```text
https://chatgpt.com/g/g-p-<project-id>[-slug]/project
```

Without a machine-local pin, `conversation_create()` defaults to a root `https://chatgpt.com/` conversation. After `project_pin`, later creates start from that Project home unless an explicit `project_url` overrides it. Project-scoped threads are persisted and reattached using their canonical `/g/g-p-.../c/...` URLs.

Runtime state lives under `data/` and is ignored by Git.

## Secure MCP Tunnel

A remote MCP client can reach the local sidecar through OpenAI Secure MCP Tunnel. The local stdio adapter is:

```bash
npm run mcp:stdio
```

It forwards newline-delimited MCP JSON-RPC to the already-running local endpoint at `http://127.0.0.1:7337/mcp`; it does not control Chrome directly.

Example managed runtime command:

```bash
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...

tunnel-client runtimes connect \
  --alias sidecar \
  --profile sidecar \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "node <checkout>/src/mcp-stdio.mjs"
```

## Development

```bash
npm test
```

No third-party runtime dependencies are required. Platform-specific behavior should stay confined to the Native Messaging installation/launcher boundary unless a concrete OS requirement proves otherwise.
