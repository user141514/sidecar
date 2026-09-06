import { chmod, lstat, mkdir, readFile, readlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform as currentPlatform } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'

const commandMarker = 'conversation-sidecar runtime shim'
const skillNamePattern = /^---\s*[\s\S]*?^name:\s*chatgpt-subagents\s*$/m

function pathApi(platform) {
  if (platform === 'linux') return posix
  if (platform === 'win32') return win32
  throw new Error(`Unsupported platform: ${platform}`)
}

function normalizeForCompare(value, platform) {
  const normalized = pathApi(platform).normalize(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function resolveUserInstallPaths({
  platform = currentPlatform(),
  homeDirectory = homedir(),
  roamingAppData = process.env.APPDATA
} = {}) {
  const path = pathApi(platform)
  if (platform === 'linux') {
    return {
      commandDir: path.join(homeDirectory, '.local', 'bin'),
      skillDir: path.join(homeDirectory, '.agents', 'skills', 'chatgpt-subagents')
    }
  }
  const appData = roamingAppData ?? path.join(homeDirectory, 'AppData', 'Roaming')
  return {
    commandDir: path.join(appData, 'npm'),
    skillDir: path.join(homeDirectory, '.agents', 'skills', 'chatgpt-subagents')
  }
}

function pathContainsDirectory(commandDir, pathValue, platform) {
  if (typeof pathValue !== 'string' || !pathValue) return false
  const separator = platform === 'win32' ? ';' : ':'
  const expected = normalizeForCompare(commandDir, platform)
  return pathValue.split(separator).filter(Boolean).some((entry) => normalizeForCompare(entry, platform) === expected)
}

function legacyCommandPattern(command) {
  const leaf = command === 'chatgpt-conversation' ? 'cli.mjs' : 'work-cli.mjs'
  return new RegExp(`(?:conversation-sidecar|multi-conversation)[\\\\/]src[\\\\/]${leaf.replace('.', '\\.')}\\b`, 'i')
}

async function classifyCommand(path, command) {
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent' }
    throw error
  }

  if (stat.isSymbolicLink()) {
    const target = await readlink(path)
    const resolved = resolve(dirname(path), target)
    return legacyCommandPattern(command).test(resolved)
      ? { kind: 'legacy-symlink' }
      : { kind: 'foreign' }
  }

  const content = await readFile(path, 'utf8')
  if (content.includes(commandMarker)) return { kind: 'managed' }
  if (legacyCommandPattern(command).test(content)) return { kind: 'legacy-file' }
  return { kind: 'foreign' }
}

async function classifySkill(path, expectedContent) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  if (content === expectedContent || skillNamePattern.test(content)) return { kind: 'managed' }
  return { kind: 'foreign' }
}

function conflict(path) {
  const error = new Error(`user entrypoint conflict: ${path}`)
  error.code = 'USER_ENTRYPOINT_CONFLICT'
  return error
}

function shellDoubleQuote(value) {
  return String(value).replace(/[\\"$`]/g, '\\$&')
}

function cmdDoublePercent(value) {
  return String(value).replace(/%/g, '%%')
}

function commandFile(platform, command) {
  return platform === 'win32' ? `${command}.cmd` : command
}

function commandBody({ platform, runtimeHome, command }) {
  const path = pathApi(platform)
  const target = path.join(runtimeHome, 'bin', commandFile(platform, command))
  if (platform === 'linux') {
    return `#!/usr/bin/env sh\n# ${commandMarker}\nexec "${shellDoubleQuote(target)}" "$@"\n`
  }
  return `@echo off\r\nREM ${commandMarker}\r\ncall "${cmdDoublePercent(target)}" %*\r\n`
}

export async function installRuntimeUserEntrypoints({
  runtimeHome,
  releaseDir,
  platform = currentPlatform(),
  homeDirectory = homedir(),
  roamingAppData = process.env.APPDATA,
  commandDir,
  skillDir,
  pathValue = process.env.PATH,
  dryRun = false
} = {}) {
  if (typeof runtimeHome !== 'string' || !runtimeHome) throw new TypeError('runtimeHome is required')
  if (typeof releaseDir !== 'string' || !releaseDir) throw new TypeError('releaseDir is required')
  const defaults = resolveUserInstallPaths({ platform, homeDirectory, roamingAppData })
  commandDir ??= defaults.commandDir
  skillDir ??= defaults.skillDir

  const commands = ['chatgpt-conversation', 'conversation-work']
  const commandPlans = []
  for (const command of commands) {
    const targetPath = join(commandDir, commandFile(platform, command))
    const classification = await classifyCommand(targetPath, command)
    if (classification.kind === 'foreign') throw conflict(targetPath)
    commandPlans.push({ command, targetPath, classification })
  }

  const skillSource = join(releaseDir, 'skills', 'chatgpt-subagents', 'SKILL.md')
  const skillContent = await readFile(skillSource, 'utf8')
  const skillPath = join(skillDir, 'SKILL.md')
  const skillClassification = await classifySkill(skillPath, skillContent)
  if (skillClassification.kind === 'foreign') throw conflict(skillPath)

  const result = {
    status: dryRun ? 'ready' : 'installed',
    commandDir,
    skillDir,
    skillPath,
    commands: commandPlans.map((item) => item.targetPath),
    pathReady: pathContainsDirectory(commandDir, pathValue, platform)
  }
  if (dryRun) return result

  await mkdir(commandDir, { recursive: true })
  await mkdir(skillDir, { recursive: true })
  for (const plan of commandPlans) {
    if (plan.classification.kind === 'legacy-symlink') await unlink(plan.targetPath)
    await writeFile(plan.targetPath, commandBody({ platform, runtimeHome, command: plan.command }), 'utf8')
    if (platform === 'linux') await chmod(plan.targetPath, 0o755)
  }
  await writeFile(skillPath, skillContent, 'utf8')
  return result
}
