#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  let payload
  try {
    payload = input.trim() ? JSON.parse(input) : {}
  } catch {
    process.exit(0)
  }

  const prompt = typeof payload?.user_prompt === 'string' ? payload.user_prompt : ''
  if (!shouldTrigger(prompt)) return

  const authority = readRuntimeAuthority()
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: formatContext(authority)
    }
  }))
})

function shouldTrigger(prompt) {
  if (!prompt) return false
  return [
    /\bsidecar\b/i,
    /\bconversation[_-]?worker\b/i,
    /\bconversation-work\b/i,
    /\bchatgpt-conversation\b/i,
    /\bsubagents\b.{0,24}\bproject\b/i,
    /\bchild conversation\b/i,
    /\bchild chat\b/i,
    /(?:chatgpt|gpt).{0,16}(?:子对话|子聊天)/i,
    /(?:子对话|子聊天).{0,16}(?:chatgpt|gpt|subagents)/i,
    /(?:开|开启|拉起|创建|新建|调用|派发|启动).{0,12}(?:子对话|子聊天)/i
  ].some((pattern) => pattern.test(prompt))
}

function runtimeHome() {
  if (process.env.SIDECAR_RUNTIME_HOME) return path.resolve(process.env.SIDECAR_RUNTIME_HOME)
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'Conversation Sidecar')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Conversation Sidecar')
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'conversation-sidecar')
}

function findOnPath(name) {
  const pathValue = process.env.PATH || ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  const names = process.platform === 'win32'
    ? [name, ...extensions.map((ext) => name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext.toLowerCase())]
    : [name]

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {}
    }
  }
  return null
}

function readRuntimeAuthority() {
  const home = runtimeHome()
  const configPath = path.join(home, 'runtime.json')
  let config = null
  let error = null
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  const project = config?.managed_project && typeof config.managed_project === 'object'
    ? config.managed_project
    : null
  const projectUrl = typeof project?.url === 'string' ? project.url : null
  const canonicalProject = Boolean(
    projectUrl &&
    /^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/project$/.test(projectUrl)
  )

  return {
    runtimeHome: home,
    configPath,
    state: typeof config?.state === 'string' ? config.state : null,
    release: typeof config?.current_release === 'string' ? config.current_release : null,
    projectName: typeof project?.name === 'string' ? project.name : null,
    projectUrl,
    canonicalProject,
    conversationWork: findOnPath('conversation-work'),
    chatgptConversation: findOnPath('chatgpt-conversation'),
    configError: error
  }
}

function formatContext(authority) {
  const ready = authority.state === 'ready' &&
    authority.canonicalProject &&
    Boolean(authority.conversationWork) &&
    Boolean(authority.chatgptConversation)

  const lines = [
    'SIDECAR_TRIGGERED: This prompt may require a real managed ChatGPT child conversation.',
    'Before substantive Sidecar work, read and follow /home/ad/.agents/skills/chatgpt-subagents/SKILL.md (or the platform-equivalent installed conversation-workers Skill).',
    'Use the installed Runtime Home and stable CLI as execution authority. A Git checkout/worktree is source authority only when modifying Sidecar itself.',
    'Do not use project-find as managed Project authority; do not reconstruct a Project URL from memory; do not fall back to root https://chatgpt.com/.',
    'Do not substitute DevSpace host_worker or Orca workers when the requested worker is a real ChatGPT child conversation.',
    'Sidecar managed children must never select or switch to Pro. Normalize only to a non-Pro mode when required to set an allowed strength. Default and ceiling: High. Extra High / 极高 and any future stronger level are forbidden.',
    'If the prompt explicitly asks for DevSpace host workers or Orca workers instead, route to that system and ignore Sidecar execution.',
    '',
    'SIDECAR_RUNTIME_AUTHORITY:',
    `ready=${ready}`,
    `runtime_config=${authority.configPath}`,
    `state=${authority.state ?? 'unknown'}`,
    `release=${authority.release ?? 'unknown'}`,
    `managed_project.name=${authority.projectName ?? 'unknown'}`,
    `managed_project.url=${authority.projectUrl ?? 'unknown'}`,
    `conversation-work=${authority.conversationWork ?? 'missing'}`,
    `chatgpt-conversation=${authority.chatgptConversation ?? 'missing'}`
  ]

  if (authority.configError) lines.push(`runtime_config_error=${authority.configError}`)
  if (!ready) {
    lines.push('')
    lines.push('Sidecar runtime is not proven ready. Fail closed: diagnose the stable Runtime Home/CLI instead of using checkout-local commands, stale cross-host paths, project-find fallback, or root ChatGPT.')
  } else {
    lines.push('')
    lines.push('For managed child work, prefer conversation-work create -> decide -> dispatch -> collect. WorkController owns the canonical subagents Project route. Treat pacing as a transport admission result; wait/retry after retryAfterMs rather than bypassing it.')
  }
  return lines.join('\n')
}
