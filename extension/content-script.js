;(function () { // A fresh closure allows safe content-script reinjection.
try { globalThis.__sidecarContentRuntime?.dispose() } catch {
  // The prior listener belongs to an extension context Chrome has invalidated.
}
let contentDisposed = false
let preparedSend = null
const contentBuildId = globalThis.__sidecarBuildId ?? 'unversioned'
globalThis.__sidecarContentRuntime = {
  buildId: contentBuildId,
  monitorTurn,
  getComposerMode,
  readTurnObservation,
  dispose() {
    contentDisposed = true
    chrome.runtime.onMessage.removeListener?.(onSidecarMessage)
  }
}

const POLL_INTERVAL_MS = 500
const SNAPSHOT_INTERVAL_MS = 5_000
const SNAPSHOT_QUIESCENCE_MS = 10_000
const MONITOR_TIMEOUT_MS = 20 * 60 * 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findPromptEditor() {
  return document.querySelector('#prompt-textarea') ||
    [...document.querySelectorAll('[contenteditable="true"]')].find((node) => {
      const label = (node.getAttribute('aria-label') || node.getAttribute('data-placeholder') || '').toLowerCase()
      return label.includes('message') || label.includes('prompt') || label.includes('消息')
    })
}

async function waitForPromptEditor() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const editor = findPromptEditor()
    if (editor) return editor
    await sleep(250)
  }
  throw new Error('ChatGPT prompt editor was not found')
}

function setPromptText(editor, text) {
  editor.focus()

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(editor, text)
    else editor.value = text
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    return
  }

  document.execCommand('selectAll', false)
  const inserted = document.execCommand('insertText', false, text)
  if (!inserted) {
    editor.textContent = text
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }
}

function findSendButton() {
  const explicit = document.querySelector('[data-testid="send-button"]')
  if (explicit) return explicit
  return [...document.querySelectorAll('button')].find((button) => {
    const label = (button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase()
    return label === 'send' || label.includes('send message') || label.includes('发送')
  })
}

async function waitAndSubmit(beforeClick = null) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const button = findSendButton()
    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
      beforeClick?.()
      const baselineUserCount = userMessages().length
      const form = button.closest?.('form')
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit(button)
      else button.click()
      for (let confirm = 0; confirm < 20; confirm += 1) {
        const editor = findPromptEditor()
        const draft = editor
          ? (typeof editor.value === 'string' ? editor.value : (editor.innerText || editor.textContent || ''))
          : ''
        if (userMessages().length > baselineUserCount) {
          const userMessageId = userMessages().at(-1)?.getAttribute?.('data-message-id') || ''
          if (userMessageId) return { userMessageId }
        }
        await sleep(125)
      }
      throw Object.assign(new Error('ChatGPT submit click produced no observable submission progress'), { deliveryUncertain: true })
    }
    await sleep(125)
  }
  throw new Error('ChatGPT send button did not become available')
}

function elementLabel(node) {
  return (
    node?.getAttribute?.('aria-label') ||
    node?.getAttribute?.('data-testid') ||
    node?.getAttribute?.('title') ||
    node?.textContent ||
    ''
  ).trim()
}

function findToolsButton() {
  const explicit = document.querySelector('[data-testid="composer-plus-btn"]') ||
    document.querySelector('[data-testid="composer-tools-button"]')
  if (explicit) return explicit

  return [...document.querySelectorAll('button')].find((button) => {
    const label = elementLabel(button).toLowerCase()
    return label === '+' ||
      label.includes('add files') ||
      label.includes('add photos') ||
      label.includes('tools') ||
      label.includes('more') ||
      label.includes('添加') ||
      label.includes('工具')
  })
}

function appMenuCandidates() {
  return [...document.querySelectorAll(
    '[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item], button'
  )]
}

function findAppMenuItem(appName) {
  const target = appName.trim().toLowerCase()
  return appMenuCandidates().find((node) => {
    const label = elementLabel(node).toLowerCase()
    return label === target || label === `@${target}` || label.startsWith(`${target} `)
  })
}

async function selectAppForMessage(appName) {
  if (typeof appName !== 'string' || !appName.trim()) throw new Error('App name is required')
  const toolsButton = findToolsButton()
  if (!toolsButton) throw new Error('ChatGPT tools menu button was not found')
  toolsButton.click()

  let expandedMore = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const appItem = findAppMenuItem(appName)
    if (appItem) {
      appItem.click()
      return
    }

    if (!expandedMore) {
      const more = appMenuCandidates().find((node) => {
        const label = elementLabel(node).toLowerCase()
        return label === 'more' || label === 'apps' || label === 'plugins' || label === '更多' || label === '应用'
      })
      if (more) {
        more.click()
        expandedMore = true
      }
    }
    await sleep(100)
  }
  throw new Error(`ChatGPT app was not found in the tools menu: ${appName}`)
}

const WEBGPT_STRENGTH_ALIASES = [
  { strength: 'Extra High', aliases: ['extra high', '极高'] },
  { strength: 'Instant', aliases: ['instant', '即时'] },
  { strength: 'Medium', aliases: ['medium', '中等', '中'] },
  { strength: 'High', aliases: ['high', '高'] }
]
const WEBGPT_STRENGTH_OFFSET = new Map([
  ['Instant', 0],
  ['Medium', 1],
  ['High', 2],
  ['Extra High', 3]
])
const WEBGPT_MODEL_MODE_ALIASES = [
  { mode: 'Thinking', aliases: ['thinking', '思考'] },
  { mode: 'Instant', aliases: ['instant', '即时'] },
  { mode: 'Pro', aliases: ['pro'] }
]

function canonicalWebGptModelMode(value) {
  const label = String(value ?? '').trim().toLowerCase()
  for (const entry of WEBGPT_MODEL_MODE_ALIASES) {
    for (const alias of entry.aliases) {
      const target = alias.toLowerCase()
      if (
        label === target ||
        label.startsWith(`${target} `) ||
        label.startsWith(`${target}·`) ||
        label.startsWith(`${target} ·`) ||
        label.endsWith(` ${target}`) ||
        label.includes(` ${target} `)
      ) return entry.mode
    }
  }
  return null
}

function canonicalWebGptStrength(value) {
  const label = String(value ?? '').trim().toLowerCase()
  for (const entry of WEBGPT_STRENGTH_ALIASES) {
    for (const alias of entry.aliases) {
      const target = alias.toLowerCase()
      if (label === target || label.endsWith(` ${target}`)) return entry.strength
    }
  }
  return null
}

function webGptStrengthFromNode(node) {
  return canonicalWebGptStrength(elementLabel(node))
}

function isWebGptPickerOption(node) {
  const role = String(node?.getAttribute?.('role') ?? '').toLowerCase()
  return role === 'menuitem' || role === 'menuitemradio' || role === 'option' || role === 'radio'
}

function webGptStrengthControlCandidates() {
  const seen = new Set()
  const out = []
  for (const selector of ['button', '[role="button"]', '[aria-haspopup]', '[aria-controls]', '.__composer-pill']) {
    for (const node of document.querySelectorAll(selector)) {
      if (seen.has(node)) continue
      seen.add(node)
      out.push(node)
    }
  }
  return out
}

function findWebGptStrengthControl() {
  return webGptStrengthControlCandidates().find((control) => {
    if (control.disabled || isWebGptPickerOption(control)) return false
    const label = elementLabel(control).toLowerCase()
    if (label.includes('switch model') || label.includes('切换模型')) return false
    return label.includes('reasoning') ||
      label.includes('思考强度') ||
      label.includes('推理强度') ||
      Boolean(webGptStrengthFromNode(control))
  }) || null
}

function webGptModelModeFromNode(node) {
  return canonicalWebGptModelMode(elementLabel(node))
}

function findWebGptModelControl() {
  return webGptStrengthControlCandidates().find((control) => {
    if (control.disabled || isWebGptPickerOption(control)) return false
    const label = elementLabel(control).toLowerCase()
    return label.includes('switch model') ||
      label.includes('切换模型') ||
      Boolean(webGptModelModeFromNode(control))
  }) || null
}

function webGptModelOptionCandidates(control) {
  const popupId = control?.getAttribute?.('aria-controls')
  const popup = popupId && typeof document.getElementById === 'function'
    ? document.getElementById(popupId)
    : null
  const popupCandidates = popup?.querySelectorAll ? [...popup.querySelectorAll('*')] : []
  return popupCandidates.length ? popupCandidates : appMenuCandidates()
}

function findWebGptModelOption(target, control) {
  return webGptModelOptionCandidates(control)
    .find((node) => !node.disabled && webGptModelModeFromNode(node) === target) || null
}

async function ensureWebGptModelMode(target) {
  const control = findWebGptModelControl()
  if (!control) throw new Error('ChatGPT model control was not found')
  const before = webGptModelModeFromNode(control) || elementLabel(control)
  if (before === target) return { before, after: target }

  openWebGptStrengthControl(control)
  let option = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    option = findWebGptModelOption(target, control)
    if (option) break
    await yieldWebGptUi()
  }
  if (!option) throw new Error(`ChatGPT model option was not found: ${target}`)
  option.click()

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const afterControl = findWebGptModelControl()
    const after = afterControl ? webGptModelModeFromNode(afterControl) : null
    if (after === target) return { before, after }
    await yieldWebGptUi()
  }
  throw new Error(`ChatGPT model control did not read back target: ${target}`)
}

async function yieldWebGptUi() {
  if (typeof MessageChannel !== 'function') {
    await Promise.resolve()
    return
  }
  await new Promise((resolveYield) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close?.()
      channel.port2.close?.()
      resolveYield()
    }
    channel.port2.postMessage(0)
  })
}

async function waitForWebGptStrengthControl() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const control = findWebGptStrengthControl()
    if (control) return control
    await yieldWebGptUi()
  }
  return null
}

function webGptStrengthOptionCandidates(control) {
  const popupId = control?.getAttribute?.('aria-controls')
  const popup = popupId && typeof document.getElementById === 'function'
    ? document.getElementById(popupId)
    : null
  const popupCandidates = popup?.querySelectorAll ? [...popup.querySelectorAll('*')] : []
  return popupCandidates.length ? popupCandidates : appMenuCandidates()
}

function findWebGptStrengthOption(target, control) {
  const wanted = canonicalWebGptStrength(target)
  if (!wanted) return null
  return webGptStrengthOptionCandidates(control)
    .find((node) => !node.disabled && webGptStrengthFromNode(node) === wanted) || null
}

function webGptStrengthOptionDiagnostics(control) {
  return webGptStrengthOptionCandidates(control)
    .map(elementLabel)
    .filter((label) => label && label.length <= 40)
    .slice(-20)
}

function findWebGptStrengthSlider(control) {
  return webGptStrengthOptionCandidates(control).find((node) => {
    const role = node?.getAttribute?.('role')
    const rawValue = node?.getAttribute?.('aria-valuenow')
    const value = rawValue === null || rawValue === undefined ? null : Number(rawValue)
    return role === 'slider' || Number.isInteger(value)
  }) || null
}

function webGptStrengthBaseIndex(slider) {
  const min = Number(slider?.getAttribute?.('aria-valuemin'))
  const max = Number(slider?.getAttribute?.('aria-valuemax'))
  if (Number.isInteger(min) && Number.isInteger(max) && max - min >= 4) return min
  return 1
}

function webGptStrengthTargetIndex(slider, strength) {
  const offset = WEBGPT_STRENGTH_OFFSET.get(strength)
  if (!Number.isInteger(offset)) return null
  return webGptStrengthBaseIndex(slider) + offset
}

function webGptStrengthFromSlider(slider) {
  if (!slider) return null
  const valueText = slider.getAttribute?.('aria-valuetext')
  const labeled = canonicalWebGptStrength(valueText) || canonicalWebGptStrength(elementLabel(slider))
  if (labeled) return labeled
  const index = Number(slider.getAttribute?.('aria-valuenow'))
  const base = webGptStrengthBaseIndex(slider)
  for (const [strength, offset] of WEBGPT_STRENGTH_OFFSET) {
    if (index === base + offset) return strength
  }
  return null
}

async function driveWebGptStrengthSlider(slider, wanted) {
  const targetIndex = webGptStrengthTargetIndex(slider, wanted)
  let currentIndex = Number(slider?.getAttribute?.('aria-valuenow'))
  if (!Number.isInteger(targetIndex) || !Number.isInteger(currentIndex)) return false
  if (currentIndex === targetIndex) return true
  if (typeof KeyboardEvent !== 'function' || typeof slider?.dispatchEvent !== 'function') return false

  slider.focus?.()
  const maxSteps = Math.abs(targetIndex - currentIndex)
  for (let step = 0; step < maxSteps && currentIndex !== targetIndex; step += 1) {
    const key = targetIndex < currentIndex ? 'ArrowLeft' : 'ArrowRight'
    slider.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, code: key }))
    slider.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key, code: key }))
    await Promise.resolve()
    const nextIndex = Number(slider.getAttribute?.('aria-valuenow'))
    if (!Number.isInteger(nextIndex) || nextIndex === currentIndex) return false
    currentIndex = nextIndex
  }
  return currentIndex === targetIndex
}

function openWebGptStrengthControl(control) {
  const className = typeof control?.className === 'string'
    ? control.className
    : control?.getAttribute?.('class') || ''
  if (className.includes('__composer-pill')) {
    control.click()
    return
  }
  if (typeof PointerEvent === 'function' && typeof control?.dispatchEvent === 'function') {
    control.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerType: 'mouse',
      isPrimary: true
    }))
    return
  }
  control.click()
}

async function runWebGptShiftTest(target) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('WebGPT shift target is required')
  const wanted = canonicalWebGptStrength(target)
  if (!wanted) throw new Error(`Unsupported WebGPT shift target: ${target}`)

  let control = await waitForWebGptStrengthControl()
  let before = null
  if (!control) {
    const modelControl = findWebGptModelControl()
    if (modelControl) {
      before = webGptModelModeFromNode(modelControl) || elementLabel(modelControl)
      if (wanted === 'Instant') {
        await ensureWebGptModelMode('Instant')
        return { switched: true, before, after: 'Instant' }
      }
      await ensureWebGptModelMode('Thinking')
      control = await waitForWebGptStrengthControl()
    }
  }
  if (!control) {
    const candidates = webGptStrengthControlCandidates()
      .map(elementLabel)
      .filter((label) => label && label.length <= 40)
      .slice(-20)
    throw new Error(`WebGPT thinking control was not found; candidates=${JSON.stringify(candidates)}`)
  }
  before ??= webGptStrengthFromNode(control) || elementLabel(control)
  openWebGptStrengthControl(control)

  let option = null
  let slider = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    option = findWebGptStrengthOption(wanted, control)
    if (option) break
    slider = findWebGptStrengthSlider(control)
    if (slider) break
    await yieldWebGptUi()
  }
  if (option) {
    option.click()
  } else if (slider) {
    const moved = await driveWebGptStrengthSlider(slider, wanted)
    if (!moved) {
      const index = slider.getAttribute?.('aria-valuenow')
      throw new Error(`WebGPT capability slider did not reach ${wanted}; index=${index ?? 'unknown'}`)
    }
  } else {
    const candidates = webGptStrengthOptionDiagnostics(control)
    throw new Error(`WebGPT thinking option was not found: ${wanted}; candidates=${JSON.stringify(candidates)}`)
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const afterControl = findWebGptStrengthControl()
    const after = webGptStrengthFromSlider(slider) || (afterControl ? (webGptStrengthFromNode(afterControl) || elementLabel(afterControl)) : null)
    if (after === wanted) return { switched: true, before, after }
    await yieldWebGptUi()
  }
  throw new Error(`WebGPT thinking control did not read back target: ${wanted}`)
}

function controlLabel(node) {
  return (node?.getAttribute?.('aria-label') || node?.textContent || '').trim().toLowerCase()
}

function findEnabledButton(root, labels) {
  const wanted = new Set(labels.map((label) => label.toLowerCase()))
  return [...root.querySelectorAll('button')].find((button) => {
    return !button.disabled && wanted.has(controlLabel(button))
  })
}

async function waitForEnabledButton(rootProvider, labels) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const root = rootProvider()
    if (root?.querySelectorAll) {
      const button = findEnabledButton(root, labels)
      if (button) return button
    }
    await sleep(125)
  }
  throw new Error(`ChatGPT control was not found: ${labels[0]}`)
}

function findProjectNameInput(dialog) {
  const inputs = [...dialog.querySelectorAll('input')]
  return inputs.find((input) => {
    const hint = [
      input.getAttribute?.('aria-label'),
      input.getAttribute?.('placeholder'),
      input.getAttribute?.('name')
    ].filter(Boolean).join(' ').toLowerCase()
    return hint.includes('project') || hint.includes('name') || hint.includes('项目') || hint.includes('名称')
  }) || null
}

function isProjectDialog(dialog) {
  const label = controlLabel(dialog)
  const isProjectLabeled = label.includes('new project') ||
    label.includes('create project') ||
    label.includes('新建项目') ||
    label.includes('创建项目')
  return isProjectLabeled && Boolean(findProjectNameInput(dialog))
}

async function waitForProjectDialog() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(isProjectDialog)
    if (dialog) return dialog
    await sleep(125)
  }
  throw new Error('ChatGPT Project dialog was not found')
}

async function waitForProjectNameInput(dialog) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const input = findProjectNameInput(dialog)
    if (input) return input
    await sleep(125)
  }
  throw new Error('ChatGPT Project name input was not found')
}

function setTextInput(input, text) {
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, text)
  else input.value = text
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
}

function canonicalProjectHomeFromHref(href) {
  if (typeof href !== 'string' || !href) return null
  try {
    const parsed = new URL(href, location.href)
    if (parsed.origin !== 'https://chatgpt.com') return null
    const path = parsed.pathname.replace(/\/+$/, '')
    return /^\/g\/g-p-[^/]+\/project$/.test(path) ? `${parsed.origin}${path}` : null
  } catch {
    return null
  }
}

function projectIdentityFromUrl(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url, location.href)
    if (parsed.origin !== 'https://chatgpt.com') return null
    const match = parsed.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[^/]+)?(?=\/)/i)
    return match ? `${parsed.origin}/g/${match[1].toLowerCase()}` : null
  } catch {
    return null
  }
}

async function handleProjectFind(message) {
  const name = typeof message.name === 'string' ? message.name.trim() : ''
  if (!name) throw new Error('Project name is required')
  const wanted = name.toLowerCase()
  for (const link of document.querySelectorAll('a[href]')) {
    const label = (link.textContent || '').trim().toLowerCase()
    if (label !== wanted) continue
    const projectUrl = canonicalProjectHomeFromHref(link.getAttribute?.('href'))
    if (projectUrl) return { found: true, name, projectUrl }
  }
  return { found: false, name }
}

async function handleProjectOpen(message) {
  const projectUrl = canonicalProjectHomeFromHref(message.projectUrl)
  if (!projectUrl) throw new Error('Valid Project URL is required')
  const projectIdentity = projectIdentityFromUrl(projectUrl)
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (const link of document.querySelectorAll('a[href]')) {
      const navigationProjectUrl = canonicalProjectHomeFromHref(link.getAttribute?.('href'))
      if (!navigationProjectUrl) continue
      if (navigationProjectUrl !== projectUrl &&
          (!projectIdentity || projectIdentityFromUrl(navigationProjectUrl) !== projectIdentity)) continue
      link.click()
      return {
        accepted: true,
        projectUrl: navigationProjectUrl,
        control: {
          kind: 'project-link',
          tag: link.tagName?.toLowerCase?.() || 'a',
          role: link.getAttribute?.('role') || null,
          className: link.getAttribute?.('class') || '',
          text: (link.textContent || '').trim()
        }
      }
    }
    await sleep(125)
  }
  throw new Error('ChatGPT Project anchor was not found')
}

async function handleProjectCreate(message) {
  const name = typeof message.name === 'string' ? message.name.trim() : ''
  if (!name) throw new Error('Project name is required')

  const newProjectButton = await waitForEnabledButton(
    () => document,
    ['new project', '新建项目', '创建项目', '新项目']
  )
  newProjectButton.click()

  const dialog = await waitForProjectDialog()
  const input = await waitForProjectNameInput(dialog)
  setTextInput(input, name)

  const createButton = await waitForEnabledButton(
    () => dialog,
    ['create', 'create project', '创建', '创建项目']
  )
  createButton.click()
  return { accepted: true, name }
}

function assistantMessages() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')]
}

function userMessages() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')]
}

function nodeText(node) {
  return (node?.innerText || node?.textContent || '').trim()
}

function userMessageText(node) {
  const content = node?.querySelector?.('[data-testid="collapsible-user-message-content"]')
  return nodeText(content || node)
}

function turnKey(node) {
  const turn = node?.closest?.('[data-testid^="conversation-turn-"]')
  return turn?.getAttribute?.('data-testid') || node?.getAttribute?.('data-message-id') || null
}

function bodySnapshot(message) {
  const shellText = nodeText(message)
  if (!message) return { bodyText: '', bodyComplete: false, shellText }

  // Test doubles from older fixtures do not model element traversal. Real DOM
  // nodes always do; preserve those fixtures without weakening the browser path.
  if (typeof message.querySelector !== 'function') {
    return { bodyText: shellText, bodyComplete: Boolean(shellText), shellText }
  }

  const root = message.querySelector(
    '[data-message-content], [data-testid="assistant-message-content"], .markdown, [class*="markdown"], [class*="prose"]'
  )
  if (!root) return { bodyText: '', bodyComplete: false, shellText }

  const bodyText = nodeText(root)
  if (!bodyText) return { bodyText: '', bodyComplete: false, shellText }
  if (typeof root.querySelector !== 'function') {
    return { bodyText, bodyComplete: true, shellText }
  }

  const substantive = root.querySelector(
    'p, li, pre, code, table, blockquote, dl, dd, dt, [data-message-content-leaf]'
  )
  const heading = root.querySelector('h1, h2, h3, h4, h5, h6')
  return {
    bodyText,
    bodyComplete: Boolean(substantive) || !heading,
    shellText
  }
}

function readTurnObservation({ baselineAssistantCount = 0, promptText = '' } = {}) {
  const assistants = assistantMessages()
  const users = userMessages()
  const normalizedPrompt = typeof promptText === 'string' ? promptText.trim() : ''
  let anchor = null
  let last = assistants.at(-1) ?? null

  if (normalizedPrompt) {
    anchor = [...users].reverse().find((user) => userMessageText(user) === normalizedPrompt) ?? null
    if (!anchor) last = null
    else {
      const following = assistants.filter((assistant) => {
        const relation = anchor?.compareDocumentPosition?.(assistant)
        return typeof relation === 'number' && (relation & 4) !== 0
      })
      last = following.at(-1) ?? null
    }
  }

  const present = normalizedPrompt
    ? Boolean(anchor && last)
    : assistants.length > Number(baselineAssistantCount ?? 0) && Boolean(last)
  const body = bodySnapshot(present ? last : null)
  const turn = last?.closest?.('[data-testid^="conversation-turn-"]')
  const terminalActionAvailable = Boolean(turn?.querySelector?.(
    '[data-testid="copy-turn-action-button"], [data-testid="feedback-turn-action-button"], button[aria-label*="Copy response" i], button[aria-label*="复制回复"]'
  ))

  return {
    url: location.href,
    userTurnKey: anchor ? turnKey(anchor) : null,
    assistantTurnKey: present ? turnKey(last) : null,
    present,
    bodyText: body.bodyText,
    bodyComplete: body.bodyComplete,
    shellText: body.shellText,
    continuationAvailable: getComposerMode() === 'INTERRUPTED',
    terminalActionAvailable
  }
}

function readConversationStateObservation(expectedUserMessageId) {
  const users = userMessages()
  const assistants = assistantMessages()
  const anchor = typeof expectedUserMessageId === 'string' && expectedUserMessageId
    ? users.find(user => user?.getAttribute?.('data-message-id') === expectedUserMessageId) ?? null
    : null
  if (!anchor) {
    return {
      ready: true, url: location.href, readable: false,
      userMessageId: null, assistantMessageId: null, assistantText: null,
      generating: null, terminal: null, body: 'unknown', humanGate: null
    }
  }

  const newerUser = users.some(user => user !== anchor && (() => {
    const relation = anchor?.compareDocumentPosition?.(user)
    return typeof relation === 'number' && (relation & 4) !== 0
  })())
  if (newerUser) {
    return {
      ready: true, url: location.href, readable: false,
      userMessageId: anchor.getAttribute?.('data-message-id') || null,
      assistantMessageId: null, assistantText: null,
      generating: null, terminal: null, body: 'unknown', humanGate: null
    }
  }

  const following = assistants.filter(assistant => {
    const relation = anchor?.compareDocumentPosition?.(assistant)
    return typeof relation === 'number' && (relation & 4) !== 0
  })
  const assistant = following.at(-1) ?? null
  const body = bodySnapshot(assistant)
  const turn = assistant?.closest?.('[data-testid^="conversation-turn-"]')
  const finalActionAvailable = Boolean(turn?.querySelector?.(
    '[data-testid="copy-turn-action-button"], [data-testid="feedback-turn-action-button"], button[aria-label*="Copy response" i], button[aria-label*="复制回复"]'
  ))
  const mode = getComposerMode()
  const generating = mode === 'GENERATING'
  const assistantText = assistant ? (body.bodyText || '') : ''
  const humanGate = Boolean(document.querySelector('[data-testid="tool-approval-card"]')) ||
    /(?:^|\n)\[SUPERVISOR_STATE\s*:\s*NEED_INPUT\]\s*$/.test(assistantText)
  const bodyState = !assistant
    ? 'empty'
    : mode === 'INTERRUPTED'
      ? 'incomplete'
      : body.bodyComplete
        ? 'substantive'
        : (body.bodyText || body.shellText) ? 'incomplete' : 'empty'

  return {
    ready: true,
    url: location.href,
    readable: true,
    userMessageId: anchor.getAttribute?.('data-message-id') || null,
    assistantMessageId: assistant?.getAttribute?.('data-message-id') || null,
    assistantText,
    generating,
    terminal: generating || mode === 'INTERRUPTED' ? false : finalActionAvailable,
    body: bodyState,
    humanGate
  }
}

function isGenerating() {
  if (document.querySelector('[data-testid="stop-button"]')) return true
  return [...document.querySelectorAll('button')].some((button) => {
    const label = (button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase()
    return label.includes('stop streaming') ||
      label.includes('stop generating') ||
      label.includes('stop responding') ||
      label.includes('stop response') ||
      label.includes('停止生成') ||
      label.includes('停止回答') ||
      label === 'stop'
  })
}

function getComposerMode() {
  const buttons = [...document.querySelectorAll('button')]
  const labels = buttons.map((button) => (
    button.getAttribute('aria-label') || button.textContent || ''
  ).trim().toLowerCase())
  const alerts = [...document.querySelectorAll('[role="alert"]')].map(nodeText)
  const hasError = labels.some((label) =>
    label.includes('try again') || label === 'retry' || label.includes('重试')
  ) || alerts.some((text) => /something went wrong|network error|出了点问题|网络错误/i.test(text))
  if (hasError) return 'ERROR'
  if (isGenerating()) return 'GENERATING'
  if (labels.some((label) =>
    label.includes('continue generating') ||
    label.includes('continue response') ||
    label.includes('continue answering') ||
    label.includes('继续生成') ||
    label.includes('继续回答')
  )) return 'INTERRUPTED'

  const editor = findPromptEditor()
  const draft = (editor?.value || editor?.innerText || editor?.textContent || '').trim()
  return draft ? 'DRAFT_READY' : 'IDLE_EMPTY'
}

async function emitTerminalEvent(event) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'conversation_event', event })
      if (response?.durable === true) return true
    } catch {
      // Retry the same logical terminal event; the service worker de-duplicates it.
    }
    if (attempt < 2) await sleep(500)
  }
  return false
}

async function monitorTurn({ conversationId, turnId, baselineAssistantCount, promptText, startedAt, monitorVersion, recovery = false }) {
  let inactivityDeadline = Number.isFinite(startedAt)
    ? Number(startedAt) + MONITOR_TIMEOUT_MS
    : Date.now() + MONITOR_TIMEOUT_MS
  let observedGenerating = false
  let generationExited = false
  let candidateSnapshot = null
  let stableSnapshotSince = null
  let lastSnapshotAt = null
  try {
    while (!contentDisposed && Date.now() < inactivityDeadline) {
      await sleep(POLL_INTERVAL_MS)
      if (contentDisposed) return

      const mode = getComposerMode()
      if (mode === 'ERROR') {
        const durable = await emitTerminalEvent({
          type: 'error',
          conversationId,
          turnId,
          monitorVersion,
          message: 'ChatGPT composer entered an error state',
          externalUrl: location.href
        })
        if (durable) return
        continue
      }

      if (mode === 'GENERATING') {
        observedGenerating = true
        generationExited = false
        inactivityDeadline = Date.now() + MONITOR_TIMEOUT_MS
        candidateSnapshot = null
        stableSnapshotSince = null
        lastSnapshotAt = null
        continue
      }

      const observation = readTurnObservation({ baselineAssistantCount, promptText })
      const terminalBoundary = observation.terminalActionAvailable || mode === 'INTERRUPTED'
      if (observedGenerating) {
        generationExited = true
      } else if (
        typeof promptText === 'string' &&
        promptText.trim() &&
        observation.userTurnKey &&
        observation.present &&
        terminalBoundary
      ) {
        // The monitor may attach after a fast response has already left GENERATING.
        // Exact user-turn anchoring plus current non-generating composer state is
        // the recovery proof; text quiescence alone never establishes lifecycle.
        generationExited = true
      }
      if (!generationExited) continue
      if (!terminalBoundary) {
        candidateSnapshot = null
        stableSnapshotSince = null
        lastSnapshotAt = Date.now()
        continue
      }

      const now = Date.now()
      if (lastSnapshotAt !== null && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) continue
      lastSnapshotAt = now

      const snapshot = JSON.stringify({
        mode,
        userTurnKey: observation.userTurnKey,
        assistantTurnKey: observation.assistantTurnKey,
        present: observation.present,
        bodyText: observation.bodyText,
        bodyComplete: observation.bodyComplete,
        shellText: observation.shellText,
        terminalActionAvailable: observation.terminalActionAvailable
      })
      if (snapshot !== candidateSnapshot) {
        candidateSnapshot = snapshot
        stableSnapshotSince = now
        inactivityDeadline = now + MONITOR_TIMEOUT_MS
        continue
      }
      if (stableSnapshotSince === null || now - stableSnapshotSince < SNAPSHOT_QUIESCENCE_MS) continue

      const complete = mode !== 'INTERRUPTED' && observation.present && observation.bodyComplete
      const event = complete
        ? {
            type: 'response_completed',
            conversationId,
            turnId,
            monitorVersion,
            text: observation.bodyText,
            externalUrl: location.href
          }
        : {
            type: 'need_continue',
            conversationId,
            turnId,
            monitorVersion,
            text: observation.bodyText || observation.shellText || '',
            reason: mode === 'INTERRUPTED' ? 'generation_interrupted' : 'assistant_body_incomplete',
            externalUrl: location.href
          }
      const durable = await emitTerminalEvent(event)
      if (durable) return
      stableSnapshotSince = now
    }
    if (contentDisposed) return
    await emitTerminalEvent({
      type: 'error',
      conversationId,
      turnId,
      monitorVersion,
      message: 'Timed out waiting for ChatGPT generation to complete',
      externalUrl: location.href
    })
  } catch (error) {
    await emitTerminalEvent({
      type: 'error',
      conversationId,
      turnId,
      monitorVersion,
      message: error instanceof Error ? error.message : String(error),
      externalUrl: location.href
    })
  }
}

function composerDraft(editor = findPromptEditor()) {
  return typeof editor?.value === 'string' ? editor.value : (editor?.innerText || editor?.textContent || '')
}

function writerObservation(ownedDraft = null, requireTerminalEvidence = true, requireTextHumanGate = true) {
  const users = userMessages(), assistants = assistantMessages()
  const user = users.at(-1), assistant = assistants.at(-1)
  const userMessageId = user?.getAttribute?.('data-message-id') || ''
  const assistantMessageId = assistant?.getAttribute?.('data-message-id') || ''
  const userPending = Boolean(user && (!assistant || ((assistant.compareDocumentPosition?.(user) || 0) & 4)))
  const turn = assistant?.closest?.('[data-testid^="conversation-turn-"]')
  const finalized = Boolean(turn?.querySelector?.('[data-testid="copy-turn-action-button"], [data-testid="feedback-turn-action-button"]'))
  const editor = findPromptEditor()
  const draft = composerDraft(editor)
  const text = nodeText(assistant)
  const liveApprovalGate = Boolean(document.querySelector('[data-testid="tool-approval-card"]'))
  const textualHumanGate = /(?:^|\n)\[SUPERVISOR_STATE\s*:\s*NEED_INPUT\]\s*$/.test(text)
  const needsInput = liveApprovalGate || (requireTextHumanGate && textualHumanGate)
  const busy = isGenerating() || turn?.getAttribute?.('aria-busy') === 'true' || Boolean(turn?.querySelector?.('[aria-busy="true"]'))
  const reason = userPending ? 'user_turn_pending' : busy ? 'assistant_active' : needsInput ? 'need_input' :
    !editor || editor.getAttribute?.('aria-disabled') === 'true' ? 'composer_unavailable' :
    (ownedDraft === null ? Boolean(draft.trim()) : draft.replace(/\r\n/g, '\n') !== ownedDraft.replace(/\r\n/g, '\n')) ? 'composer_changed' :
    requireTerminalEvidence && assistant && !finalized ? 'terminal_evidence_missing' : null
  return { ready: true, url: location.href, allowed: reason === null, reason, userMessageId, assistantMessageId,
    stamp: JSON.stringify([location.href, users.length, assistants.length, userMessageId, assistantMessageId, userMessageText(user), text]) }
}

function assertWriterObservation(observation, expected = null) {
  if (!observation.allowed) throw new Error(observation.reason)
  if (expected && (observation.userMessageId !== expected.userMessageId || observation.assistantMessageId !== expected.assistantMessageId)) throw new Error('stale_intent')
}

async function handlePrepare(message) {
  if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('Prompt text is required')
  const baselineAssistantCount = assistantMessages().length
  let editor = await waitForPromptEditor()
  if (message.app !== undefined) {
    await selectAppForMessage(message.app)
    editor = await waitForPromptEditor()
  }
  const authoritativeState = message.authoritativeState === true
  const observation = message.guarded === true ? writerObservation(null, !authoritativeState, !authoritativeState) : null
  if (observation) assertWriterObservation(observation, message.expected)
  setPromptText(editor, message.text)
  if (observation) {
    const ownedDraft = composerDraft(editor)
    if (!ownedDraft.trim()) throw new Error('composer_changed')
    preparedSend = { turnId: message.turnId, text: ownedDraft, stamp: observation.stamp, expected: message.expected, authoritativeState }
  }
  return {
    prepared: true,
    url: location.href,
    baselineAssistantCount
  }
}

async function handleSubmit(message = {}) {
  const prepared = preparedSend
  const guard = message.guarded === true ? () => {
    if (!prepared || prepared.turnId !== message.turnId) throw new Error('prepared_intent_missing')
    const observation = writerObservation(prepared.text, prepared.authoritativeState !== true, prepared.authoritativeState !== true)
    assertWriterObservation(observation, prepared.expected)
    if (observation.stamp !== prepared.stamp) throw new Error('stale_intent')
  } : null
  const submission = await waitAndSubmit(guard)
  preparedSend = null
  return {
    accepted: true,
    userMessageId: submission.userMessageId,
    url: location.href
  }
}

async function resumePendingTurn() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const pending = await chrome.runtime.sendMessage({ kind: 'pending_turn_lookup' })
      if (!contentDisposed && pending?.conversationId && pending?.turnId) {
        void monitorTurn({
          conversationId: pending.conversationId,
          turnId: pending.turnId,
          baselineAssistantCount: Number(pending.baselineAssistantCount ?? 0),
          promptText: pending.promptText,
          startedAt: pending.startedAt,
          monitorVersion: pending.monitorVersion,
          recovery: true
        })
      }
      return
    } catch {
      // A freshly loaded document can race the service worker becoming ready.
    }
    if (attempt < 7) await sleep(250)
  }
}

function onSidecarMessage(message, _sender, sendResponse) {
  if (contentDisposed) return
  if (message?.type === 'sidecar_ping') {
    sendResponse({
      ready: true, url: location.href, buildId: contentBuildId, generating: isGenerating(),
      composerPresent: Boolean(findPromptEditor()), title: document.title,
      headings: [...document.querySelectorAll('h1, h2')].map(node => node.textContent?.trim()).slice(0, 8),
      buttons: [...document.querySelectorAll('button')].map(elementLabel).filter(Boolean).slice(0, 16),
      editors: [...document.querySelectorAll('textarea, [contenteditable="true"]')].map(node => ({
        tag: node.tagName, id: node.id, placeholder: node.getAttribute('placeholder'), label: node.getAttribute('aria-label')
      })).slice(0, 5)
    })
    return
  }

  if (message?.type === 'conversation_observe') {
    sendResponse(writerObservation(null, message.authoritativeState !== true, message.authoritativeState !== true))
    return
  }

  if (message?.type === 'conversation_state_observe') {
    sendResponse(readConversationStateObservation(message.expectedUserMessageId))
    return
  }

  if (message?.type === 'conversation_snapshot') {
    const last = assistantMessages().at(-1)
    sendResponse({
      ready: true,
      url: location.href,
      generating: isGenerating(),
      assistantText: (last?.innerText || last?.textContent || '').trim()
    })
    return
  }

  if (message?.type === 'webgpt_shift_test') {
    void runWebGptShiftTest(message.target)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        switched: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    return true
  }

  if (message?.type === 'project_find') {
    void handleProjectFind(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        found: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    return true
  }

  if (message?.type === 'project_open') {
    void handleProjectOpen(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        accepted: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    return true
  }

  if (message?.type === 'project_create') {
    void handleProjectCreate(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        accepted: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    return true
  }

  if (message?.type === 'conversation_monitor_start') {
    void monitorTurn({
      conversationId: message.conversationId,
      turnId: message.turnId,
      baselineAssistantCount: Number(message.baselineAssistantCount ?? 0),
      promptText: message.promptText,
      startedAt: message.startedAt,
      monitorVersion: message.monitorVersion,
      recovery: message.recovery === true
    })
    sendResponse({ started: true })
    return
  }

  if (message?.type === 'conversation_prepare') {
    void handlePrepare(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        prepared: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    return true
  }

  if (message?.type === 'conversation_submit') {
    void handleSubmit(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        accepted: false,
        deliveryUncertain: error.deliveryUncertain === true,
        error: error instanceof Error ? error.message : String(error)
      }))
    return true
  }

  return
}

function runHashShiftProbe() {
  const prefix = '#webgpt-shift-test='
  if (typeof location.hash !== 'string' || !location.hash.startsWith(prefix)) return
  const target = decodeURIComponent(location.hash.slice(prefix.length))
  void runWebGptShiftTest(target)
    .then((result) => { document.title = `WEBGPT_SHIFT_OK|${result.before}|${result.after}` })
    .catch((error) => { document.title = `WEBGPT_SHIFT_ERROR|${error instanceof Error ? error.message : String(error)}` })
}

chrome.runtime.onMessage.addListener(onSidecarMessage)
void resumePendingTurn()
runHashShiftProbe()
})()
