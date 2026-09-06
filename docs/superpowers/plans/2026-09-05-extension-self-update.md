# Cross-platform extension self-update implementation plan

> Execute inline; no Orca and no worker code edits. Audit each step before proceeding.

**Goal:** Both Sidecar and the standalone conversation provider ship the same extension, CLI update/status protocol, MCP tools and Skill. Linux/Windows differ only at installation links and launchers.

**Architecture:** An independent Node CLI requests an idle-only extension reload through the existing localhost MCP/native bridge. The extension persists a request receipt, acknowledges, and invokes runtime.reload. The CLI survives the old native host exiting, reconnects and verifies request token, new instance ID and target build ID. Existing managed tabs receive fresh content scripts through scripting.executeScript, never tab/window navigation or reload. Unmanaged tabs are not touched. All payloads and executable code come from this checkout, not remote strings.

## Invariants and boundaries

- Reload admission rejects durable pending turns, unacknowledged terminal outbox records and in-flight browser mutations. No force/bypass flag.
- The admission flag is acquired before asynchronous checks. New browser mutations cannot race admission.
- Accepted is not applied: only a fresh instance reporting the same request token and expected build can satisfy the CLI.
- Build fingerprints cover manifest, service worker, content script and lifecycle implementation, normalized to LF. Build-info is captured at execution time; disk edits alone do not claim a new loaded build.
- The CLI owns bounded reconnect waiting, since reloading may terminate the native host serving the original HTTP connection.
- Managed content scripts are idempotently reinjected only into the exact still-matching tabs; no create, focus, navigate, browser restart, profile edit or GUI automation.
- Old releases without the reload handler require ONE manual bootstrap reload. This is not silently bypassed through CDP/UI.
- Do not modify the active checkout or its native-host registration during implementation. Use an isolated worktree; preserve previous dirty changes.
- Git fetch/push use SSH. main is an unrelated initial-commit root, so do not rebase unrelated histories.
- Both SSH remotes are verified: user141514/sidecar.git and user141514/chatgpt-conversation.git. Preserve the independent provider's existing main ancestry (00a14e9); a local detached worktree is not publication evidence.
- Linux-executed Windows fixtures are contract evidence, NOT a real Windows Chrome gate.

## Step 1 — shared lifecycle and reconnect controller

**Status: implemented; focused tests and adversarial self-audit passed.**

Files: extension/lifecycle.js, src/extension-control.mjs, test/extension-update.test.mjs.

- [ ] RED: baseline must reject unknown extension_status/update commands; add execution tests asserting pending blocks reload, concurrent admission blocks a send, storage failure never reloads, and ack precedes reload.
- [ ] Implement createSidecarLifecycle: status(), requestReload({requestId, expectedInstanceId, expectedBuildId}), runMutation(fn), restoreAfterReload(). Receipt persisted before runtime.reload.
- [ ] Implement updateExtension(callTool,{expectedBuildId,timeoutMs}): preflight, one reload request, bounded reconnect/status reads; only matching token/new epoch/build and restored scripts returns verified.
- [ ] Tests: old epoch, wrong token/build, lost HTTP ACK, transient ECONNRESET, stale endpoint and expired deadline fail closed.
- [ ] Audit safety, same-token retry, and native-host replacement boundaries.

## Step 2 — wire runtime, build identity and shared CLI/MCP

**Status: implemented; runtime, reconnect and compatibility tests passed.**

Files: extension/service-worker.js, extension/content-script.js, extension/manifest.json, extension/build-info.js, scripts/extension-build.mjs, src/server.mjs, src/cli.mjs, related tests.

- [ ] Add extension_status and extension_reload tools using the existing bridge; do not introduce a second transport or OS-specific protocol.
- [ ] Load lifecycle and build-info in the worker. All browser mutation requests enter the same admission guard.
- [ ] Make content reinjection disposable/idempotent and ping report loaded build; stop disposed monitors without publishing terminal events.
- [ ] CLI commands: extension-status; extension-update [--timeout-ms N]; extension-reload alias. Keep all conversation/project commands.
- [ ] `node scripts/extension-build.mjs --check` verifies deterministic package identity; `--write` prepares a candidate from this checkout.
- [ ] Audit full test suite and package contents; no update is marked deployed from tests alone.

## Step 3 — platform links and standalone packaging

**Status: implemented; both local suites and all 37 shared-file comparisons passed. SSH publication and remote Windows execution are separate gates.**

Files: install/platform-link.mjs, install/install-host.mjs, package.json, skills/chatgpt-subagents/SKILL.md, .github/workflows/test.yml, scripts/export-provider.mjs.

- [ ] Move OS path/registry/launcher choices into one link adapter; retain shared manifest identity and stdio semantics.
- [ ] Ship npm bin for the same JS CLI on both systems and Windows/POSIX native launchers.
- [ ] Standalone export is explicit allowlist: extension + provider source + CLI/MCP + Skill + adapter + their tests, not work/memory/controller business logic.
- [ ] Assert exported extension/CLI/control/Skill bytes match Sidecar; run standalone suite outside Sidecar to detect checkout dependencies.
- [ ] CI matrix ubuntu-latest/windows-latest, Node 24, npm test and build-info check. Windows-only live tests remain explicit.
- [ ] Audit and commit to a unified feature branch; push Sidecar by SSH. Publish standalone only to confirmed SSH destination.

## Step 4 — deployment gate

- [x] Inspect real installed status without browser UI. Old version reports Unknown tool: extension_status; stop at manual bootstrap.
- [ ] After bootstrap, invoke CLI update; verify a new instance, token/build match and no pending loss. No fresh child is needed to test reload itself.
- [ ] Report separately: implementation/tests, repository publication, Linux live reload, Windows live reload. Never merge these into one success claim.

## Sources

Chrome runtime: https://developer.chrome.com/docs/extensions/reference/api/runtime
Native-host lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
Injection: https://developer.chrome.com/docs/extensions/reference/api/scripting

## Final validation and deployment status

- Shared suite: 130 tests, 128 passed, 0 failed, 2 Windows-only skipped on Linux.
- Standalone suite in `/home/ad/gitproject/chatgpt-conversation`: 86 tests, 84 passed, 0 failed, 2 Windows-only skipped.
- Independent local repository created on `feat/shared-extension-update`; initial generated snapshot 31b9b83 is retained as a backup. Public repository discovery followed by SSH fetch verified the existing remote main at 00a14e9. The final publication must be parented to that remote history, not to an unrelated generated root.
- All 37 allowlisted shared files compared byte-for-byte with the independent repository: zero mismatches. Extension build `c1ed6706f950cf62c0809033fc747ef3497143dcfe036a94cabc8329c9720c1a`, fixed ID `cfifihieaffhniimpimnfmignbbdaalb`.
- Syntax check: 24 JS/MJS files, zero failures. `git diff --check` clean.
- CodeRabbit invocation reached reviewing but was stopped at the 100-second budget, exit 124; no completed external review verdict is claimed.
- Actual installed read-only probe returned `Unknown tool: extension_status`. Native host PID remained 1255120, launched from the original checkout. No GUI automation, reload, new child, native-host re-registration or global CLI replacement was performed.
- Therefore source/tests/package gates pass, but initial deployment/bootstrap and real Chrome self-reload remain NOT VERIFIED. Windows CI is configured, not reported as an observed Windows run.
- The previous real child-pull gate is not retroactively declared successful by this update feature.

## Evidence

Step 1 audit: nine initial missing-feature tests were RED, then GREEN. Follow-up adversarial review found duplicate-request ACK could precede its original receipt write; a deferred-storage regression was RED and fixed by awaiting the same admission promise. HTTP integration additionally verifies native-server close/rebind, not just a mocked accepted response.

Step 2 audit: content-script reinjection now has an isolated closure, captured build identity and disposal of the prior listener/monitor. Existing conversation runtime tests remain unchanged in behavior; tests address the runtime through its explicit object rather than leaked global functions. No page/window navigation is in the updater.

Step 3 compatibility audit: preserved the original provider's CLI, installer command and endpoint environment-variable contracts. Tests caught a broken installed-bin symlink and lost CHATGPT_CONVERSATION_MCP_URL support; both were RED and then GREEN after correction. The legacy install entry delegates to the same platform adapter. Windows startup tests derive the expected service identity from the package rather than assuming the integrated Sidecar brand.

Reinjection audit: an invalidated old extension context may throw during disposal. A real content-script execution test reproduced this; the new script now continues bootstrapping safely. The uncorrelated-restart test exercises a fresh instance with the wrong receipt, not only an unchanged old instance.

Step 3 audit: standalone allowlist export was RED before implementation. Package equality covers extension/CLI/schema/Skill/link files; standalone suite runs inside an independent distribution with no work/memory/controller modules. Native path and launcher tests pass on Linux; actual Windows execution is not yet observed.

Baseline: 105 tests, existing dirty protocol work captured as 6b8340b796f5f3ad3a03dae69250b7b93643cb05; active checkout untouched. origin/main has an unrelated root (11/1 divergence, no merge base). Initial local discovery found provider source 00a14e9 only in a detached worktree, and GitHub CLI was unauthenticated. Later public API discovery and SSH fetch independently confirmed git@github.com:user141514/chatgpt-conversation.git at that exact commit.
