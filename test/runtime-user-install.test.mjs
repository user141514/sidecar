import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function loadModule() {
  try { return await import('../install/runtime-user-install.mjs') } catch { return {} }
}

test('tracked Sidecar Skill uses the canonical conversation-workers identity', async () => {
  const skill = await readFile(new URL('../skills/chatgpt-subagents/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /^---\s*[\s\S]*?^name:\s*conversation-workers\s*$/m)
  assert.doesNotMatch(skill, /^name:\s*chatgpt-subagents\s*$/m)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-user-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtimeHome = join(root, 'runtime home')
  const releaseDir = join(runtimeHome, 'releases', 'a'.repeat(40))
  await mkdir(join(runtimeHome, 'bin'), { recursive: true })
  await mkdir(join(releaseDir, 'skills', 'chatgpt-subagents'), { recursive: true })
  await writeFile(join(runtimeHome, 'bin', 'chatgpt-conversation'), '#!/usr/bin/env sh\n', 'utf8')
  await writeFile(join(runtimeHome, 'bin', 'conversation-work'), '#!/usr/bin/env sh\n', 'utf8')
  await writeFile(join(runtimeHome, 'bin', 'chatgpt-conversation.cmd'), '@echo off\r\n', 'utf8')
  await writeFile(join(runtimeHome, 'bin', 'conversation-work.cmd'), '@echo off\r\n', 'utf8')
  const skill = '---\nname: chatgpt-subagents\ndescription: managed runtime skill\n---\n\n# Runtime Skill\n'
  await writeFile(join(releaseDir, 'skills', 'chatgpt-subagents', 'SKILL.md'), skill, 'utf8')
  return { root, runtimeHome, releaseDir, skill }
}

test('user install paths use platform-native user command and Skill locations', async () => {
  const { resolveUserInstallPaths } = await loadModule()
  assert.equal(typeof resolveUserInstallPaths, 'function')
  if (typeof resolveUserInstallPaths !== 'function') return

  assert.deepEqual(resolveUserInstallPaths({
    platform: 'linux',
    homeDirectory: '/home/ad'
  }), {
    commandDir: '/home/ad/.local/bin',
    skillDir: '/home/ad/.agents/skills/chatgpt-subagents'
  })

  assert.deepEqual(resolveUserInstallPaths({
    platform: 'win32',
    homeDirectory: 'C:\\Users\\14579',
    roamingAppData: 'C:\\Users\\14579\\AppData\\Roaming'
  }), {
    commandDir: 'C:\\Users\\14579\\AppData\\Roaming\\npm',
    skillDir: 'C:\\Users\\14579\\.agents\\skills\\chatgpt-subagents'
  })
})

test('Linux user install writes Runtime-Home shims and exact managed Skill idempotently', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const home = join(f.root, 'home')
  const commandDir = join(home, '.local', 'bin')
  const runtimeHome = '/home/ad/runtime home'

  const first = await installRuntimeUserEntrypoints({
    runtimeHome,
    releaseDir: f.releaseDir,
    platform: 'linux',
    homeDirectory: home,
    pathValue: commandDir
  })
  const second = await installRuntimeUserEntrypoints({
    runtimeHome,
    releaseDir: f.releaseDir,
    platform: 'linux',
    homeDirectory: home,
    pathValue: commandDir
  })

  const chat = await readFile(join(commandDir, 'chatgpt-conversation'), 'utf8')
  const work = await readFile(join(commandDir, 'conversation-work'), 'utf8')
  assert.match(chat, /conversation-sidecar runtime shim/)
  assert.match(chat, /\/home\/ad\/runtime home\/bin\/chatgpt-conversation/)
  assert.match(work, /conversation-sidecar runtime shim/)
  assert.doesNotMatch(chat, /releases[\\/][0-9a-f]{40}/)
  assert.equal(await readFile(join(home, '.agents', 'skills', 'chatgpt-subagents', 'SKILL.md'), 'utf8'), f.skill)
  assert.equal(typeof first.pathReady, 'boolean')
  assert.equal(second.status, 'installed')
})

test('Windows user install emits POSIX and cmd shims under roaming npm command directory', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const home = win32.join('C:\\Users', '14579')
  const appData = win32.join(home, 'AppData', 'Roaming')
  const commandDir = win32.join(appData, 'npm')
  const fsRoot = join(f.root, 'windows-fs')
  const mappedCommandDir = join(fsRoot, 'npm')
  const mappedSkillDir = join(fsRoot, 'skills', 'chatgpt-subagents')

  const result = await installRuntimeUserEntrypoints({
    runtimeHome: 'C:\\Runtime Home',
    releaseDir: f.releaseDir,
    platform: 'win32',
    homeDirectory: home,
    roamingAppData: appData,
    commandDir: mappedCommandDir,
    skillDir: mappedSkillDir,
    pathValue: mappedCommandDir
  })

  const chatPosix = await readFile(join(mappedCommandDir, 'chatgpt-conversation'), 'utf8')
  const chatCmd = await readFile(join(mappedCommandDir, 'chatgpt-conversation.cmd'), 'utf8')
  const workPosix = await readFile(join(mappedCommandDir, 'conversation-work'), 'utf8')
  const workCmd = await readFile(join(mappedCommandDir, 'conversation-work.cmd'), 'utf8')
  assert.match(chatPosix, /conversation-sidecar runtime shim/)
  assert.match(chatPosix, /cygpath -u/)
  assert.match(chatPosix, /C:\\Runtime Home\\bin\\chatgpt-conversation/)
  assert.match(chatCmd, /REM conversation-sidecar runtime shim/)
  assert.match(chatCmd, /C:\\Runtime Home\\bin\\chatgpt-conversation\.cmd/)
  assert.match(workPosix, /C:\\Runtime Home\\bin\\conversation-work/)
  assert.match(workCmd, /C:\\Runtime Home\\bin\\conversation-work\.cmd/)
  assert.deepEqual(result.commands.map((path) => win32.basename(path)).sort(), [
    'chatgpt-conversation',
    'chatgpt-conversation.cmd',
    'conversation-work',
    'conversation-work.cmd'
  ])
  assert.equal(await readFile(join(mappedSkillDir, 'SKILL.md'), 'utf8'), f.skill)
  assert.equal(result.pathReady, true)
})

test('Windows user install preflights an extensionless foreign shim before writing managed files', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const commandDir = join(f.root, 'windows-command-dir')
  const skillDir = join(f.root, 'windows-skill-dir')
  await mkdir(commandDir, { recursive: true })
  await writeFile(join(commandDir, 'conversation-work'), '#!/usr/bin/env sh\necho foreign\n', 'utf8')

  await assert.rejects(
    installRuntimeUserEntrypoints({
      runtimeHome: f.runtimeHome,
      releaseDir: f.releaseDir,
      platform: 'win32',
      commandDir,
      skillDir,
      pathValue: commandDir
    }),
    (error) => error?.code === 'USER_ENTRYPOINT_CONFLICT'
  )
  await assert.rejects(readFile(join(commandDir, 'chatgpt-conversation.cmd'), 'utf8'), /ENOENT/)
  await assert.rejects(readFile(join(skillDir, 'SKILL.md'), 'utf8'), /ENOENT/)
})

test('Windows Git Bash resolves the extensionless installed shim from PATH', { skip: process.platform !== 'win32' }, async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const commandDir = join(f.root, 'windows-command-dir')
  const skillDir = join(f.root, 'windows-skill-dir')
  await writeFile(
    join(f.runtimeHome, 'bin', 'chatgpt-conversation'),
    '#!/usr/bin/env sh\nprintf "SIDECAR_GIT_BASH_OK:%s\\n" "$1"\n',
    'utf8'
  )
  await installRuntimeUserEntrypoints({
    runtimeHome: f.runtimeHome,
    releaseDir: f.releaseDir,
    platform: 'win32',
    commandDir,
    skillDir,
    pathValue: commandDir
  })
  const commandDirPosix = (await execFileAsync('bash', ['-lc', `cygpath -u '${commandDir.replaceAll("'", "'\\''")}'`])).stdout.trim()
  const { stdout } = await execFileAsync('bash', [
    '-lc',
    `PATH='${commandDirPosix.replaceAll("'", "'\\''")}'\":$PATH\" chatgpt-conversation probe`
  ])
  assert.match(stdout, /SIDECAR_GIT_BASH_OK:probe/)
})

test('user install refuses a foreign command before writing any managed files', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const home = join(f.root, 'home')
  const commandDir = join(home, '.local', 'bin')
  await mkdir(commandDir, { recursive: true })
  await writeFile(join(commandDir, 'chatgpt-conversation'), '#!/bin/sh\necho foreign\n', 'utf8')

  await assert.rejects(
    installRuntimeUserEntrypoints({ runtimeHome: f.runtimeHome, releaseDir: f.releaseDir, platform: 'linux', homeDirectory: home }),
    (error) => error?.code === 'USER_ENTRYPOINT_CONFLICT'
  )
  await assert.rejects(readFile(join(commandDir, 'conversation-work'), 'utf8'), /ENOENT/)
  await assert.rejects(readFile(join(home, '.agents', 'skills', 'chatgpt-subagents', 'SKILL.md'), 'utf8'), /ENOENT/)
})

test('user install upgrades known legacy npm-link and checkout work wrappers', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const home = join(f.root, 'home')
  const commandDir = join(home, '.local', 'bin')
  const legacy = join(f.root, 'conversation-sidecar', 'src')
  await mkdir(legacy, { recursive: true })
  await mkdir(commandDir, { recursive: true })
  await writeFile(join(legacy, 'cli.mjs'), '', 'utf8')
  await symlink(join(legacy, 'cli.mjs'), join(commandDir, 'chatgpt-conversation'))
  await writeFile(join(commandDir, 'conversation-work'), `#!/bin/sh\nexec node ${join(f.root, 'conversation-sidecar', 'src', 'work-cli.mjs')} "$@"\n`, 'utf8')

  await installRuntimeUserEntrypoints({ runtimeHome: f.runtimeHome, releaseDir: f.releaseDir, platform: 'linux', homeDirectory: home })

  assert.match(await readFile(join(commandDir, 'chatgpt-conversation'), 'utf8'), /conversation-sidecar runtime shim/)
  assert.match(await readFile(join(commandDir, 'conversation-work'), 'utf8'), /conversation-sidecar runtime shim/)
})

test('user install upgrades an older canonical conversation-workers Skill in place', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const home = join(f.root, 'home')
  const skillDir = join(home, '.agents', 'skills', 'chatgpt-subagents')
  const skillSource = join(f.releaseDir, 'skills', 'chatgpt-subagents', 'SKILL.md')
  const v1 = '---\nname: conversation-workers\ndescription: managed runtime skill v1\n---\n\n# Runtime Skill\n'
  const v2 = '---\nname: conversation-workers\ndescription: managed runtime skill v2\n---\n\n# Runtime Skill\n'
  await writeFile(skillSource, v1, 'utf8')
  await installRuntimeUserEntrypoints({ runtimeHome: f.runtimeHome, releaseDir: f.releaseDir, platform: 'linux', homeDirectory: home })
  await writeFile(skillSource, v2, 'utf8')

  await installRuntimeUserEntrypoints({ runtimeHome: f.runtimeHome, releaseDir: f.releaseDir, platform: 'linux', homeDirectory: home })

  assert.equal(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), v2)
})

test('dry-run reports a standard POSIX command directory as already on PATH', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const result = await installRuntimeUserEntrypoints({
    runtimeHome: '/home/ad/.local/share/conversation-sidecar',
    releaseDir: f.releaseDir,
    platform: 'linux',
    homeDirectory: '/home/ad',
    commandDir: '/home/ad/.local/bin',
    skillDir: join(f.root, 'dry-run-skill'),
    pathValue: '/usr/local/bin:/home/ad/.local/bin:/usr/bin',
    dryRun: true
  })
  assert.equal(result.pathReady, true)
})

test('dry-run validates conflicts without writing commands or Skill', async (t) => {
  const { installRuntimeUserEntrypoints } = await loadModule()
  assert.equal(typeof installRuntimeUserEntrypoints, 'function')
  if (typeof installRuntimeUserEntrypoints !== 'function') return
  const f = await fixture(t)
  const home = join(f.root, 'home')
  const result = await installRuntimeUserEntrypoints({
    runtimeHome: f.runtimeHome,
    releaseDir: f.releaseDir,
    platform: 'linux',
    homeDirectory: home,
    dryRun: true
  })
  assert.equal(result.status, 'ready')
  await assert.rejects(readFile(join(home, '.local', 'bin', 'chatgpt-conversation'), 'utf8'), /ENOENT/)
  await assert.rejects(readFile(join(home, '.agents', 'skills', 'chatgpt-subagents', 'SKILL.md'), 'utf8'), /ENOENT/)
})
