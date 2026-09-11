;(function () { // A fresh closure allows safe content-script reinjection.
try { globalThis.__sidecarContentRuntime?.dispose() } catch {
  // The prior listener belongs to an extension context Chrome has invalidated.
}
let contentDisposed = false
const contentBuildId = globalThis.__sidecarBuildId ?? 'unversioned'
globalThis.__sidecarContentRuntime = {
  buildId: contentBuildId,
  monitorTurn,
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

async function waitAndSubmit() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const button = findSendButton()
    if (button && !button.disabled) {
      button.click()
      return
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
  { strength: 'Medium', aliases: ['medium', '中等'] },
  { strength: 'High', aliases: ['high', '高'] }
]
const WEBGPT_STRENGTH_INDEX = new Map([
  ['Instant', 1],
  ['Medium', 2],
  ['High', 3],
  ['Extra High', 4]
])

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

function findWebGptStrengthControl() {
  return [...document.querySelectorAll('button')].find((button) => {
    if (button.disabled) return false
    const label = elementLabel(button).toLowerCase()
    return label.includes('thinking') || label.includes('reasoning') || Boolean(webGptStrengthFromNode(button))
  }) || null
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

function webGptStrengthFromSlider(slider) {
  if (!slider) return null
  const valueText = slider.getAttribute?.('aria-valuetext')
  const labeled = canonicalWebGptStrength(valueText) || canonicalWebGptStrength(elementLabel(slider))
  if (labeled) return labeled
  const index = Number(slider.getAttribute?.('aria-valuenow'))
  for (const [strength, targetIndex] of WEBGPT_STRENGTH_INDEX) {
    if (index === targetIndex) return strength
  }
  return null
}

async function driveWebGptStrengthSlider(slider, wanted) {
  const targetIndex = WEBGPT_STRENGTH_INDEX.get(wanted)
  let currentIndex = Number(slider?.getAttribute?.('aria-valuenow'))
  if (!Number.isInteger(targetIndex) || !Number.isInteger(currentIndex)) return false
  if (currentIndex === targetIndex) return true
  if (typeof KeyboardEvent !== 'function' || typeof slider?.dispatchEvent !== 'function') return false

  slider.focus?.()
  const key = targetIndex < currentIndex ? 'ArrowLeft' : 'ArrowRight'
  for (let step = 0; step < Math.abs(targetIndex - currentIndex); step += 1) {
    slider.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, code: key }))
    slider.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key, code: key }))
    await sleep(100)
  }
  currentIndex = Number(slider.getAttribute?.('aria-valuenow'))
  return currentIndex === targetIndex
}

function openWebGptStrengthControl(control) {
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
  const control = findWebGptStrengthControl()
  if (!control) throw new Error('WebGPT thinking control was not found')
  const before = webGptStrengthFromNode(control) || elementLabel(control)
  openWebGptStrengthControl(control)

  let option = null
  let slider = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    option = findWebGptStrengthOption(wanted, control)
    if (option) break
    slider = findWebGptStrengthSlider(control)
    if (slider) break
    await sleep(100)
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
    await sleep(100)
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

function assistantObservation({ baselineAssistantCount, recovery, promptText }) {
  const messages = assistantMessages()
  const last = messages.at(-1)
  if (!recovery || typeof promptText !== 'string' || !promptText.trim()) {
    return { present: messages.length > baselineAssistantCount, last }
  }
  if (!last) return { present: false, last }

  const users = userMessages()
  const lastUser = users.at(-1)
  const lastUserText = (lastUser?.innerText || lastUser?.textContent || '').trim()
  const relation = lastUser?.compareDocumentPosition?.(last)
  const followsPrompt = typeof relation === 'number' && (relation & 4) !== 0
  return {
    present: Boolean(last && lastUserText === promptText.trim() && followsPrompt),
    last
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

function hasRecoveryTerminalEvidence(message) {
  const turn = message?.closest?.('[data-testid^="conversation-turn-"]')
  if (!turn?.querySelector) return false
  return Boolean(turn.querySelector(
    'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy response" i], button[aria-label*="复制回复"]'
  ))
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
  let candidateText = null
  let stableSnapshotSince = null
  let lastSnapshotAt = null
  try {
    while (!contentDisposed && Date.now() < inactivityDeadline) {
      await sleep(POLL_INTERVAL_MS)
      if (contentDisposed) return

      if (isGenerating()) {
        observedGenerating = true
        inactivityDeadline = Date.now() + MONITOR_TIMEOUT_MS
        candidateText = null
        stableSnapshotSince = null
        lastSnapshotAt = null
        continue
      }
      if (!observedGenerating && !recovery) continue

      const now = Date.now()
      if (lastSnapshotAt !== null && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) continue
      lastSnapshotAt = now

      const observation = assistantObservation({ baselineAssistantCount, recovery, promptText })
      const last = observation.last
      const text = (last?.innerText || last?.textContent || '').trim()

      if (!observation.present || !text) {
        candidateText = null
        stableSnapshotSince = null
        continue
      }
      if (!observedGenerating && recovery && !hasRecoveryTerminalEvidence(last)) {
        candidateText = null
        stableSnapshotSince = null
        continue
      }

      if (text !== candidateText) {
        candidateText = text
        stableSnapshotSince = now
        inactivityDeadline = now + MONITOR_TIMEOUT_MS
        continue
      }
      if (stableSnapshotSince === null || now - stableSnapshotSince < SNAPSHOT_QUIESCENCE_MS) continue

      const durable = await emitTerminalEvent({
        type: 'response_completed',
        conversationId,
        turnId,
        monitorVersion,
        text,
        externalUrl: location.href
      })
      if (durable) return
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

async function handlePrepare(message) {
  if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('Prompt text is required')
  const baselineAssistantCount = assistantMessages().length
  let editor = await waitForPromptEditor()
  if (message.app !== undefined) {
    await selectAppForMessage(message.app)
    editor = await waitForPromptEditor()
  }
  setPromptText(editor, message.text)
  return {
    prepared: true,
    url: location.href,
    baselineAssistantCount
  }
}

async function handleSubmit() {
  await waitAndSubmit()
  return {
    accepted: true,
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
    void handleSubmit()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        accepted: false,
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
