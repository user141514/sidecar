import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hook = fileURLToPath(new URL('../hooks/sidecar/sidecar-hooks.cjs', import.meta.url))

function run(userPrompt, env = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', user_prompt: userPrompt }),
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

test('Sidecar prompt injects runtime authority context', () => {
  const result = run('使用 sidecar 在 subagents Project 开一个子对话')
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  const context = parsed.hookSpecificOutput.additionalContext
  assert.match(context, /SIDECAR_TRIGGERED/)
  assert.match(context, /conversation-workers Skill/)
  assert.match(context, /project-find as managed Project authority/)
  assert.match(context, /conversation-work create -> decide -> dispatch -> collect/)
})

test('ordinary prompt produces no hook output', () => {
  const result = run('解释一下二叉树的层序遍历')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
})

test('generic host-worker language does not force Sidecar', () => {
  const result = run('用 DevSpace host_worker 开一个 Codex 子代理')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
})
