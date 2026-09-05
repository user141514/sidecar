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
  const editor = await waitForPromptEditor()
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
    sendResponse({ ready: true, url: location.href, buildId: contentBuildId, generating: isGenerating() })
    return
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

chrome.runtime.onMessage.addListener(onSidecarMessage)
void resumePendingTurn()
})()
