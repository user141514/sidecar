# PC2 new-UI acceptance — 2026-09-26

## Scope and hard ordering

User outcome: Sidecar and Watchdog must work on the current ChatGPT UI. Before changing or live-testing any other capability, switch the dedicated test page to Medium and independently read it back. A screenshot already showing Medium or an old passing test is not proof of this transition.

Order: identity/binding -> strength switch -> independent read-back -> Sidecar send/read/stop/recovery -> Watchdog continuation, no duplicate sends, DONE/NEED_INPUT pause -> integrated acceptance.

A failed/unverified strength transition blocks all downstream updates and live sends. Work needed to diagnose and repair the strength gate itself is in scope. Do not alter game mods, other machines, or production conversations/registrations.

## Identity and lifecycle

- Host: PC2 / DESKTOP-8AJ0CPA / Administrator.
- Source base: f4a80bc2b4b95b06534e22b6800e0cf47c063baa.
- Gate-only worktree: C:\Users\Administrator\.devspace\worktrees\sidecar-v136-25f241ee.
- Branch: fix/pc2-new-ui-strength-gate-20260926.
- Owner: this PC2 new-UI acceptance task.
- Exit: preserve the gate patch and evidence on the branch, deploy only a verified Runtime Home release, then integrate/archive the worktree when this bounded purpose is resolved. No speculative worktree retention.
- Initial Sidecar Runtime Home release: f4a80bc2b4b95b06534e22b6800e0cf47c063baa.
- Initial running extension build: 3c338f9b9dd5a5efaeb7f78eb96c920fa9dbdd629cf6fb0f6d6b01382e410c03.
- Watchdog runtime: C:\Users\Administrator\AppData\Local\chat-watchdog\runtime; registry port 9235; OMP relay 9224. Existing registration(s) must not be changed.
- Task-created test target: PAGE891835759 / ChatGPT subagents Project home, project ID g-p-6a983ccfa9148191b42da3db5412f946.

## Observed frontier

Sidecar create opened the requested Project but did not complete the draft readiness handshake. A later native `webgpt_shift_test(Medium)` returned `WebGPT thinking control was not found`.

Independent relay DOM read found:
- visible model trigger: Pro;
- aria-label: 选择 ChatGPT 模型;
- textContent: 思考强度Pro (contains a hidden measurement label);
- data-composer-navigation-target: reasoning;
- data-selected-reasoning-effort: medium even while visible Pro was selected.

Cause localized for the strength failure: generic `elementLabel` prioritizes aria-label over visible text; old strength discovery therefore ignores the model-picker trigger. Portal sliders also need explicit discovery when the trigger has no aria-controls. A remembered effort attribute must not be treated as the current selection.

## Gate-only patch

Read visible strength labels independently of generic accessible labels; recognize the observed semantic reasoning trigger; discover role=slider in a portal; exclude the trigger itself as an option; wait for observable slider index movement after a key event. Preserve native host/extension ownership and existing transport.

Counterexample: Pro is selected, but data-selected-reasoning-effort says medium. The gate must still perform the real UI transition; without a slider/option it must fail closed.

## Evidence so far

- New-UI fixture before patch: 2 failures reproduce missing control; 1 fail-closed case passes.
- New-UI plus existing content runtime tests after patch: 42/42 pass.
- Full suite before regenerating extension metadata: build identity failures, not accepted.
- After extension:build: one bootstrap test initially failed on dirty source. A clean local commit a679404b22d58eb71cd6ca801c74a56fb912c37d was created with task-scoped ChatGPT author identity (no global Git identity changes); the complete npm test suite then passed.
- Verified Runtime Home bootstrap selected release a679404b22d58eb71cd6ca801c74a56fb912c37d.
- Verified extension update: request b6ea78e8-144f-45db-901b-7c96feda1fbd; old instance b80d300d-3bc5-444d-9fe7-d2e28c61693f -> new instance 924c38b7-303f-46e6-917a-2e6435a3be79; exact build 0c15d40c8e300820333d0a6e5f1d2c5e038ac027b1ba96d8423727c7a8252c78; pending/outbox/activeOperations all 0.
- Only the task-created empty Project tab PAGE891835759 was reloaded to load the new content script. Other browser tabs and registrations were untouched.
- Native Sidecar gate call pc2-new-ui-medium-gate-patched-20260926 returned switched=true, before=Pro, after=Medium, tabId=891835759, exact Project URL without slug.
- Independent OMP relay DOM read on that same tab found slider min=0, max=4, now=1; menu text: 中，第 2 项，共 5 项。 No test prompt was submitted before this read-back.
- Real strength switch/read-back: PASS on the above PC2 target/runtime instance.
- The same order is recorded in PC2 C:\Users\Administrator\.codex\AGENTS.md for subsequent Sidecar/Watchdog engineering. This is a workflow rule, not a new runtime enforcement component.
- Sidecar remaining capabilities / Watchdog / integration: UNVERIFIED. The gate permits their next bounded tests; it does not certify them. Earlier Project draft-readiness failure remains an open frontier and must not be hidden by this strength success.

Why chain: correct trigger/slider observation -> verified Medium gate -> bounded downstream test context -> reliable new-UI Sidecar/Watchdog behavior.
