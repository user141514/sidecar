# Project conversation bootstrap

## Problem

Creating a normal ChatGPT conversation and creating a conversation inside a Project are not the same browser transition.

ChatGPT exposes two conversation URL grammars:

```text
/c/<conversation-id>
/g/<project-segment>/c/<conversation-id>
```

The second form means the conversation is a child of a Project namespace. A Project home/draft surface is represented as:

```text
/g/<project-segment>/project
```

The human-readable suffix in `<project-segment>` (for example `-subagents`) is navigation metadata, not the stable Project identity. The stable identity is the `g-p-<id>` portion.

## What did not work

### 1. Rewriting a conversation URL

A Project conversation such as:

```text
/g/<project>/c/<conversation>
```

cannot be turned into a usable Project draft by deleting `/c/<conversation>` or by cold-loading a hand-built `/project` URL.

The resource grammar is useful for identity checks, but it is not an authorization to synthesize a UI transition. In live testing, directly navigating to the derived `/project` route produced ChatGPT's Retry/error surface rather than a usable Project composer.

### 2. Starting at `https://chatgpt.com/` and synthetically clicking a Project row

The Project list uses custom controls such as `div[role=button]`. Calling `element.click()` on those controls did not reliably perform the same transition as a real browser UI activation. The URL remained on the root page.

This path was therefore removed from the committed fix.

## Working model

Separate identity from navigation authority.

### Identity

Project identity is derived from the stable `g-p-<id>` portion of either a Project home URL or a Project conversation URL.

Examples with the same identity:

```text
/g/g-p-<id>-subagents/project
/g/g-p-<id>/project
/g/g-p-<id>-subagents/c/<conversation-id>
/g/g-p-<id>/c/<conversation-id>
```

These forms may refer to the same Project identity even though their navigation URLs differ.

### Navigation authority

The authoritative Project navigation URL comes from ChatGPT's own rendered Project anchor on an already healthy Project conversation page.

A healthy Project conversation exposes a link equivalent to:

```html
<a href="/g/<project-segment>/project">Open Project</a>
```

The extension waits for this anchor and uses its actual `href`. It does not reconstruct the route by deleting or replacing URL suffixes.

## Fixed bootstrap flow

For `conversation_create --project <project-home-url>`:

```text
requested Project home
        |
        v
extract stable Project identity
        |
        v
find an already-open conversation with the same Project identity
/g/<project>/c/<seed-conversation>
        |
        v
open that healthy conversation in a new active tab
        |
        v
wait for ChatGPT content script readiness
        |
        v
wait for the conversation page's authoritative Project anchor
        |
        v
click that real <a href=".../project"> anchor
        |
        v
wait until BOTH are true:
  1. browser URL is the Project home route returned by that anchor
  2. Project composer is present
        |
        v
return local conversation allocation
threadCreated = false
        |
        v
first conversation_send
        |
        v
ChatGPT materializes a new child conversation
/g/<project>/c/<new-conversation-id>
```

The first irreversible conversation-creation boundary remains submission of the first user turn. `conversation_create` only prepares a valid Project draft surface.

## Why this fixes the failure

The previous implementation mixed three different concepts:

1. Project identity;
2. Project navigation URL;
3. Project UI state.

That allowed logically valid-looking URLs to be used as if they were valid UI transitions. ChatGPT does not behave that way: the same `/project` resource can cold-load into a Retry surface while a transition from an initialized Project conversation produces the correct draft UI.

The fixed path starts from an already initialized Project conversation and lets ChatGPT provide the navigation URL itself. This preserves the front-end state ChatGPT expects and avoids guessing whether a slug or route rewrite is sufficient.

It also closes a timing race observed during debugging: content-script readiness occurs before all Project-conversation UI links are necessarily rendered. On a same-Project seed conversation, `project_open` now waits for the authoritative Project anchor instead of falling back to weaker sidebar controls.

## Runtime invariants

A Project draft is ready only after all of the following hold:

```text
same stable Project identity
+ authoritative Project home navigation completed
+ content script ready
+ Project composer present
```

A Project conversation is created only after the resulting canonical thread URL has the grammar:

```text
/g/<same-project-identity>/c/<new-conversation-id>
```

A root conversation URL:

```text
/c/<conversation-id>
```

is not acceptable for a Project-conversation creation request.

## Live verification

The repaired flow passed an end-to-end live gate on the `subagents` Project:

```text
Project draft
  -> first turn accepted
  -> /g/<subagents-project>/c/<new-id>
  -> response_completed
```

The canary response was:

```text
PROJECT_THREAD_CREATE_OK
```

The resulting browser URL was a Project child-conversation URL, not a root `/c/...` conversation.

## Scope

This change intentionally does not solve Project discovery when no healthy same-Project conversation is available as a seed. The root-page synthetic Project-row path was excluded because it was not the path that passed the live gate.

A future bootstrap mechanism may obtain a seed from persisted history or another authoritative ChatGPT surface, but it must preserve the same rule: URL grammar may establish identity; navigation must come from a real ChatGPT-provided transition.
