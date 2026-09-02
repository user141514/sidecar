# Conversation Sidecar V0 Design

## Goal

Prove one thing only: one external ChatGPT web conversation can be created in the user's existing Chrome, prompted, monitored after the caller returns, persisted locally, and read back through MCP without recurring user interaction. A later bounded extension may pin one ChatGPT Project as the default creation target without changing the conversation identity model.

## Hard boundaries

- Do not modify DevSpace or Orca.
- Linux-only V0; the development branch is `feat/chatgpt-conversation-linux`.
- Reuse the user's existing signed-in Google Chrome profile. Do not launch a second profile and do not copy cookies.
- Operational create/send/read must not use an externally exposed CDP port, `DevToolsActivePort`, Playwright, or Puppeteer.
- Chrome extension installation is one explicit human trust action; normal operation afterward is unattended.
- No OAS, ACP, A2A, pub/sub, supervisor, vector memory, SQLite, or multi-agent protocol in V0.
- Raw local events are the source of truth. Summaries are out of scope.

## Why extension installation is one-time manual

Chrome 136+ deliberately disables `--remote-debugging-port` and `--remote-debugging-pipe` for the default Chrome data directory. Google Chrome Stable also no longer supports `--load-extension` as an unattended local unpacked-extension installation path. Linux external-extension deployment uses administrator-controlled locations.

V0 therefore respects Chrome's security boundary instead of bypassing it: the user loads the fixed-ID unpacked extension once in `chrome://extensions`. Chrome then persists it in the real profile.

## Runtime shape

```text
normal signed-in Chrome profile
   |
   +-- installed MV3 extension service worker
            |
            | Chrome Native Messaging
            v
conversation-sidecar native host + localhost MCP
            |
            +-- append-only local ledger

MCP caller
   |
   +-- first conversation_create -> extension -> create managed window0
   +-- later conversation_create -> extension -> chrome.tabs.create(windowId=window0)
   +-- conversation_send         -> extension -> ChatGPT content script
   +-- conversation_read         -> local ledger only
```

## Native Messaging contract

Sidecar -> extension:

- `conversation_create { conversationId, url }`
- `conversation_send { conversationId, turnId, text }`

Extension -> sidecar:

- request responses correlated by `requestId`
- asynchronous terminal events such as `response_completed` or `error`, each carrying a stable `eventId`

The service worker persists terminal events in a local outbox before clearing pending-turn state. The sidecar deduplicates by `eventId`, durably appends the event, then returns `event_ack`; only that acknowledgement removes the extension outbox entry. The service worker reconnects its native messaging port after disconnect and replays unacknowledged outbox events. Chrome launches the native host process from the registered user-level native host manifest.

## Browser identity and window0 invariant

V0 owns exactly one managed normal Chrome window, `window0`, inside the user's existing signed-in profile. The first `conversation_create` establishes window0 and uses its initial ChatGPT tab. Every later `conversation_create` must create a new tab inside that same window0 and must not call `chrome.windows.create()` again.

The service worker persists both window0 and each conversation-to-tab binding in `chrome.storage.local`. Before reusing a stored window0 ID it verifies that the window still exists. If the user closed window0, the next create may establish one replacement window0; it never closes or reuses unrelated user windows.

## ChatGPT content script

The content script is scoped to `https://chatgpt.com/*`. For V0 it:

1. locates the prompt editor;
2. submits one prompt;
3. returns accepted state immediately;
4. monitors assistant-message count and generation controls;
5. emits the exact raw assistant response after generation is no longer active;
6. emits a durable error on timeout/failure.

Monitoring lives in the browser content script, so completion does not depend on the lifetime of the MCP caller's turn.

## Local ledger

Each conversation owns:

```text
data/conversations/<conversation-id>/
  meta.json
  events.jsonl
```

`events.jsonl` is append-only. V0 events include `conversation_created`, `browser_attached`, `prompt_sent`, `generation_started`, `response_completed`, and `error`.

`conversation_read` never contacts Chrome. It reconstructs state from these files only.

## Restart identity and browser reattachment

A sidecar conversation is a durable logical identity; Chrome window/tab IDs are only runtime attachments.

```text
conversation_id != tabId
window0         != windowId
```

`conversation_send` must authorize an existing conversation from the local ledger, not from process memory. The ledger's latest ChatGPT conversation URL and the extension's persisted URL are durable identity evidence. Before sending, the extension verifies the stored tab attachment. If that attachment is gone, it reuses a tab in logical window0 only when the stable ChatGPT conversation URL matches; otherwise it reopens that same URL in window0 and stores the new runtime IDs. If physical window0 is gone, one replacement physical window may be created while preserving logical window0.

A completed browser event updates the extension's persisted conversation URL before forwarding the event to the native host, so a later browser restart can recover the old ChatGPT conversation even if its original tab ID no longer exists.

## Project-scoped creation

A ChatGPT Project home is represented by its canonical URL, for example `https://chatgpt.com/g/g-p-<project-id>[-slug]/project`. `project_pin` persists one such URL locally as the default creation target. `conversation_create` may also receive an explicit `project_url` for a one-off override. Opening the Project home in a fresh managed tab provides the new-chat composer for that Project; once the first prompt is accepted, the durable thread identity is the canonical `/g/g-p-.../c/...` URL.

Project name discovery and automatic Project creation remain separate UI-automation concerns and are not required for URL-based pinning.

## MCP surface

The native host binds an HTTP MCP endpoint on localhost with four tools:

- `project_pin`
- `conversation_create`
- `conversation_send`
- `conversation_read`

`conversation_send` returns after browser submission is accepted; browser monitoring continues independently of that MCP request.

## Installation

One-time:

```text
chrome://extensions
  -> Developer mode
  -> Load unpacked
  -> /home/ad/gitproject/conversation-sidecar/extension
```

Expected extension ID: `cfifihieaffhniimpimnfmignbbdaalb`.

Native Messaging manifest:

```text
~/.config/google-chrome/NativeMessagingHosts/com.conversation_sidecar.host.json
```

## Success criteria

V0 succeeds only when all of these are observed on the real Linux host:

1. the fixed-ID extension is installed once in the existing Chrome profile;
2. Chrome starts the native host automatically through Native Messaging;
3. the first `conversation_create` establishes one managed window0 using the existing signed-in profile;
4. a second `conversation_create` creates only a new tab inside the same window0, with no additional Chrome window;
5. `conversation_send` submits one prompt and returns before model generation finishes;
6. the extension later reports the completed raw response to the sidecar;
7. `conversation_read` returns that raw response entirely from the local ledger;
8. after a fresh normal Chrome restart, the extension and sidecar return unattended.

## Deferred

Windows/Edge, automatic ChatGPT Project discovery/creation, simultaneous sends, semantic search, summaries, task protocols, supervisor logic, and remote MCP exposure/authentication are deferred until V0 passes.
