# conversation-sidecar

Linux-first unattended bridge for one external ChatGPT web conversation.

## V0 runtime

```text
MCP caller
  -> conversation-sidecar native host + localhost MCP
  -> Chrome Native Messaging
  -> installed Manifest V3 extension
  -> existing signed-in ChatGPT profile in one managed Chrome window0
```

The operational create/send/read path does **not** use an externally exposed CDP port, `DevToolsActivePort`, Playwright, Puppeteer, cookie copying, or a second browser profile.

## One-time installation boundary

Chrome 136+ disables `--remote-debugging-port` and `--remote-debugging-pipe` for the default Chrome data directory. Google Chrome Stable also no longer accepts `--load-extension` as an unattended local-install path, while Linux external-extension deployment is administrator-controlled.

From a fresh Linux checkout, register the Native Messaging host before loading the extension:

```bash
cd <checkout>
node install/install-host.mjs
```

Node.js 24+ must be available as `node`. The installer generates the current user's manifest at:

```text
~/.config/google-chrome/NativeMessagingHosts/com.conversation_sidecar.host.json
```

The manifest contains an absolute path to `<checkout>/install/conversation-sidecar-host`, which starts `<checkout>/src/server.mjs`. Re-run the installer after moving the checkout.

Then complete V0's one explicit Chrome trust action:

1. Open `chrome://extensions` in the user's existing Google Chrome profile.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `<checkout>/extension`.

Expected fixed extension ID:

```text
cfifihieaffhniimpimnfmignbbdaalb
```

After this one installation, Chrome persists the extension in the existing profile. Normal create/send/read operation and future Chrome starts require no recurring remote-debugging approval or sidecar reconnect action.

When the extension starts, it calls `chrome.runtime.connectNative('com.conversation_sidecar.host')`; Chrome auto-starts `src/server.mjs`. The native connection keeps the sidecar and extension bridge alive.

### Windows registration

The browser protocol and extension are shared with Linux. Windows only changes the Native Messaging installation boundary.

From the Windows checkout, run:

```bat
install\install-host-win.bat
```

This creates the current-user Chrome registry entry:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.conversation_sidecar.host
```

It points to the installer-generated manifest at:

```text
%USERPROFILE%\AppData\Local\Conversation Sidecar\NativeMessagingHosts\com.conversation_sidecar.host.json
```

The registry value is the manifest's absolute path. The generated manifest launches the checkout's `install\conversation-sidecar-host.bat`, which delegates stdin/stdout directly to `node.exe ..\src\server.mjs`. Node.js 24+ must therefore be available as `node.exe` on the Windows user PATH visible to Chrome.

The extension still has the same fixed ID. The one-time trust action is:

1. Open `chrome://extensions` in the existing signed-in Chrome profile.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `<checkout>\extension`.

Expected extension ID:

```text
cfifihieaffhniimpimnfmignbbdaalb
```

No CDP port, secondary Chrome profile, cookie copy, or recurring browser approval is introduced on Windows.

## Browser placement

The first `conversation_create` establishes one sidecar-owned normal Chrome window, `window0`, using the existing signed-in profile. That first conversation uses window0's initial tab. Every later `conversation_create` uses `chrome.tabs.create({ windowId: window0 })`; it must not create another Chrome window. If the user closes window0, the next create establishes a replacement window0.

## MCP tools

- `project_pin` — persist one ChatGPT Project home URL as the default destination for future creates.
- `conversation_create` — create a ChatGPT conversation tab inside managed `window0`; optional `project_url` overrides the pinned Project for that create.
- `conversation_send` — submit one prompt and return after the browser accepted it.
- `conversation_read` — read durable status/raw response from the local JSONL ledger only.

A Project home URL has the form:

```text
https://chatgpt.com/g/g-p-<project-id>[-slug]/project
```

After `project_pin`, later `conversation_create` calls without arguments start from that Project home. Project-scoped threads are persisted and reattached using their canonical `/g/g-p-.../c/...` URLs. Automatic sidebar project discovery/creation is intentionally separate from this URL-based pinning path.

Local conversation data and the pinned Project configuration live under `data/conversations/` and are ignored by Git.

## Secure MCP Tunnel

ChatGPT should reach the sidecar through OpenAI Secure MCP Tunnel, not by adding another public Tailscale Funnel route. The local tunnel target is the stdio adapter:

```bash
npm run mcp:stdio
```

It forwards newline-delimited MCP JSON-RPC to the already-running local endpoint at `http://127.0.0.1:7337/mcp`. The adapter never controls Chrome directly.

This host has the official `tunnel-client` installed at `~/.local/bin/tunnel-client`. Its outbound control-plane traffic currently requires the existing local Clash proxy:

```bash
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
```

After creating an OpenAI Platform tunnel and a restricted runtime API key with Tunnels Read + Use, attach the managed runtime without storing the key in this repository:

```bash
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...

tunnel-client runtimes connect \
  --alias conversation-sidecar-linux \
  --profile conversation-sidecar-linux \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "node <checkout>/src/mcp-stdio.mjs"

tunnel-client runtimes status conversation-sidecar-linux --json
```

The tunnel runtime is not considered ready until `runtimes status` reports the managed process healthy and ready.

## Linux integration

GNOME's `google-chrome.desktop` remains a normal Chrome launcher; conversation-sidecar does not wrap Chrome startup.

## Development

```bash
node --test
```

No third-party runtime dependencies are required for V0.
