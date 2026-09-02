const POLL_INTERVAL_MS = 500
const RESPONSE_SETTLE_MS = 5_000
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

function assistantMessages() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')]
}

function isGenerating() {
  if (document.querySelector('[data-testid="stop-button"]')) return true
  return [...document.querySelectorAll('button')].some((button) => {
    const label = (button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase()
    return label.includes('stop streaming') || label.includes('stop generating') || label.includes('停止生成') || label === 'stop'
  })
}

async function emitEvent(event) {
  await chrome.runtime.sendMessage({ kind: 'conversation_event', event })
}

async function monitorTurn({ conversationId, turnId, baselineAssistantCount }) {
  const deadline = Date.now() + MONITOR_TIMEOUT_MS
  let lastText = ''
  let lastTextChangedAt = null
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      const messages = assistantMessages()
      const hasNewResponse = messages.length > baselineAssistantCount
      const last = messages.at(-1)
      const text = (last?.innerText || last?.textContent || '').trim()

      if (!hasNewResponse || !text) continue
      if (text !== lastText) {
        lastText = text
        lastTextChangedAt = Date.now()
        continue
      }
      if (isGenerating()) continue
      if (lastTextChangedAt === null || Date.now() - lastTextChangedAt < RESPONSE_SETTLE_MS) continue

      await emitEvent({
        type: 'response_completed',
        conversationId,
        turnId,
        text,
        externalUrl: location.href
      })
      return
    }
    await emitEvent({
      type: 'error',
      conversationId,
      turnId,
      message: 'Timed out waiting for ChatGPT generation to complete',
      externalUrl: location.href
    })
  } catch (error) {
    await emitEvent({
      type: 'error',
      conversationId,
      turnId,
      message: error instanceof Error ? error.message : String(error),
      externalUrl: location.href
    })
  }
}

async function handleSend(message) {
  if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('Prompt text is required')
  const baselineAssistantCount = assistantMessages().length
  const editor = await waitForPromptEditor()
  setPromptText(editor, message.text)
  await waitAndSubmit()
  return {
    accepted: true,
    url: location.href,
    baselineAssistantCount
  }
}

async function resumePendingTurn() {
  try {
    const pending = await chrome.runtime.sendMessage({ kind: 'pending_turn_lookup' })
    if (!pending?.conversationId || !pending?.turnId) return
    void monitorTurn({
      conversationId: pending.conversationId,
      turnId: pending.turnId,
      baselineAssistantCount: Number(pending.baselineAssistantCount ?? 0)
    })
  } catch {
    // No service worker/pending turn yet; normal for a freshly opened page.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'sidecar_ping') {
    sendResponse({ ready: true, url: location.href })
    return
  }

  if (message?.type === 'conversation_monitor_start') {
    void monitorTurn({
      conversationId: message.conversationId,
      turnId: message.turnId,
      baselineAssistantCount: Number(message.baselineAssistantCount ?? 0)
    })
    sendResponse({ started: true })
    return
  }

  if (message?.type !== 'conversation_send') return

  void handleSend(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      accepted: false,
      error: error instanceof Error ? error.message : String(error)
    }))
  return true
})

void resumePendingTurn()
