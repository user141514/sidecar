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

Therefore V0 has one explicit one-time trust action:

1. Open `chrome://extensions` in the user's existing Google Chrome profile.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `/home/ad/gitproject/conversation-sidecar/extension`.

Expected fixed extension ID:

```text
cfifihieaffhniimpimnfmignbbdaalb
```

After this one installation, Chrome persists the extension in the existing profile. Normal create/send/read operation and future Chrome starts require no recurring remote-debugging approval or sidecar reconnect action.

The Native Messaging host is registered at:

```text
~/.config/google-chrome/NativeMessagingHosts/com.conversation_sidecar.host.json
```

When the extension starts, it calls `chrome.runtime.connectNative('com.conversation_sidecar.host')`; Chrome auto-starts `src/server.mjs`. The native connection keeps the sidecar and extension bridge alive.

## Browser placement

The first `conversation_create` establishes one sidecar-owned normal Chrome window, `window0`, using the existing signed-in profile. That first conversation uses window0's initial tab. Every later `conversation_create` uses `chrome.tabs.create({ windowId: window0 })`; it must not create another Chrome window. If the user closes window0, the next create establishes a replacement window0.

## MCP tools

- `conversation_create` — create a ChatGPT conversation tab inside managed `window0`.
- `conversation_send` — submit one prompt and return after the browser accepted it.
- `conversation_read` — read durable status/raw response from the local JSONL ledger only.

Local data lives under `data/conversations/<conversation-id>/` and is ignored by Git.

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
  --mcp-command "/usr/bin/node /home/ad/gitproject/conversation-sidecar/src/mcp-stdio.mjs"

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
