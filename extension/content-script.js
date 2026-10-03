;(function () { // A fresh closure allows safe content-script reinjection.
try { globalThis.__sidecarContentRuntime?.dispose() } catch {
  // The prior listener belongs to an extension context Chrome has invalidated.
}
let contentDisposed = false
let preparedSend = null
const contentBuildId = globalThis.__sidecarBuildId ?? 'unversioned'
const contentEffects = globalThis.__sidecarContentEffects ??= { documentId: null, tabId: null, operations: new Map(), completed: new Map() }
const journaledMethods = new Set(['conversation_mode_select', 'conversation_prepare', 'conversation_submit', 'conversation_stop', 'webgpt_shift_test', 'project_open', 'project_create'])
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
  const legacy = document.querySelector('#prompt-textarea')
  if (legacy) return legacy
  const candidates = [...document.querySelectorAll('[contenteditable="true"]')].filter(node => {
    if (node.getAttribute('role') !== 'textbox' || node.closest?.(
      'aside, nav, [role="complementary"], [data-sidebar], [data-testid="sidebar"], [data-message-author-role], [data-message-id], [data-testid^="conversation-turn-"], [data-testid="tool-approval-card"], [role="dialog"], [hidden], [aria-hidden="true"]'
    )) return false
    const form = node.closest?.('form')
    const input = node.closest?.('[data-composer-input]')
    const body = node.closest?.('[data-composer-body]')
    if (!form || !input || !body || input.closest?.('[data-composer-body]') !== body ||
        input.closest?.('form') !== form || body.closest?.('form') !== form) return false
    const rects = node.getClientRects?.()
    if (!rects || ![...rects].some(rect => rect.width > 0 && rect.height > 0)) return false
    for (let current = node; current; current = current.parentElement) {
      const style = globalThis.getComputedStyle?.(current)
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0')) return false
    }
    return true
  })
  return candidates.length === 1 ? candidates[0] : null
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
  const explicit = currentThreadNodes('[data-testid="send-button"]')[0]
  if (explicit && visibleNode(explicit)) return explicit
  return currentThreadNodes('button').find((button) => {
    const label = (button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase()
    return label === 'send' || label.includes('send message') || label.includes('发送')
  })
}

async function waitAndSubmit(beforeClick = null) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const button = findSendButton()
    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
      beforeClick?.()
      const baselineUserIds = new Set(userMessages().map(persistentMessageId))
      const promptText = composerDraft().trim()
      const form = button.closest?.('form')
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit(button)
      else button.click()
      for (let confirm = 0; confirm < 20; confirm += 1) {
        const latest = userMessages().at(-1)
        const userMessageId = persistentMessageId(latest)
        if (PERSISTENT_MESSAGE_UUID.test(userMessageId ?? '') && !baselineUserIds.has(userMessageId) &&
            promptText && userMessageText(latest) === promptText) return { userMessageId }
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

function findComposerModeControls() {
  const groups = [...document.querySelectorAll(
    '[role="group"][aria-label="撰写器模式"], [role="group"][aria-label="Composer mode"]'
  )].filter(visibleNode)
  if (!groups.length) return null
  if (groups.length !== 1) throw new Error('Composer mode group is ambiguous')
  const group = groups[0]
  if (group.closest('[role="dialog"], [inert], [aria-disabled="true"], fieldset[disabled]')) {
    throw new Error('Composer mode group is unavailable')
  }
  const buttons = [...group.querySelectorAll('button[type="button"][aria-pressed]')]
    .filter(button => button.getAttribute('role') !== 'tab')
  if (buttons.length !== 2 || buttons.some(button =>
    button.closest('[role="group"]') !== group || !visibleNode(button) || button.disabled ||
    button.getAttribute('disabled') !== null || button.closest('[inert], [aria-disabled="true"]')
  )) throw new Error('Composer mode controls are unavailable')
  const controls = {}
  for (const button of buttons) {
    const label = elementLabel(button).toLowerCase()
    const mode = label === 'chat' || label === '聊天' ? 'chat' :
      label === 'work' || label === '工作' ? 'work' : null
    if (!mode || controls[mode] || !['true', 'false'].includes(button.getAttribute('aria-pressed'))) {
      throw new Error('Composer mode controls are ambiguous')
    }
    controls[mode] = button
  }
  if (!controls.chat || !controls.work ||
      buttons.filter(button => button.getAttribute('aria-pressed') === 'true').length !== 1) {
    throw new Error('Composer mode selection is ambiguous')
  }
  return controls
}

function assertExpectedComposerMode(mode) {
  if (mode === undefined) return
  if (mode !== 'chat' && mode !== 'work') throw new Error('Composer mode must be chat or work')
  const controls = findComposerModeControls()
  if (!controls) throw new Error('Composer mode is unavailable')
  if (controls[mode].getAttribute('aria-pressed') !== 'true') {
    throw new Error('Composer mode changed; expected ' + mode)
  }
}

async function selectComposerMode(mode) {
  if (mode !== 'chat' && mode !== 'work') throw new Error('Composer mode must be chat or work')
  const controls = findComposerModeControls()
  // A missing toggle does not prove a legacy Chat surface.
  if (!controls) throw new Error('Composer mode is unavailable')
  if (controls[mode].getAttribute('aria-pressed') === 'true') {
    return { selected: true, mode, url: location.href }
  }
  controls[mode].click()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await yieldWebGptUi()
    const current = findComposerModeControls()
    if (current?.[mode].getAttribute('aria-pressed') === 'true') {
      return { selected: true, mode, url: location.href }
    }
  }
  throw new Error('Composer mode did not read back target: ' + mode)
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
  // New model-picker triggers have a generic aria-label. The selected level
  // is visible text; the remembered reasoning-effort attribute is not proof
  // of the active model (it may still say medium while the UI shows Pro).
  for (const label of [node?.innerText, node?.textContent, elementLabel(node)]) {
    const strength = canonicalWebGptStrength(label)
    if (strength) return strength
  }
  return null
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
    const label = [elementLabel(control), control.innerText, control.textContent].filter(Boolean).join(' ').toLowerCase()
    if (control.getAttribute?.('data-composer-navigation-target') === 'reasoning') return true
    if (label.includes('switch model') || label.includes('切换模型')) return false
    return label.includes('thinking strength') ||
      label.includes('reasoning') ||
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

  await openWebGptStrengthControl(control, () => Boolean(findWebGptModelOption(target, control)))
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
    .find((node) => node !== control && node.getAttribute?.('role') !== 'slider' && !node.disabled && webGptStrengthFromNode(node) === wanted) || null
}

function selectedWebGptStrengthFromOption(node) {
  if (!node) return null
  const selected = node.getAttribute?.('aria-checked') === 'true' ||
    node.getAttribute?.('aria-selected') === 'true' ||
    node.getAttribute?.('data-state') === 'checked'
  return selected ? webGptStrengthFromNode(node) : null
}

function selectedWebGptStrengthFromMenu(control) {
  for (const node of webGptStrengthOptionCandidates(control)) {
    const selected = selectedWebGptStrengthFromOption(node)
    if (selected) return selected
  }
  return null
}

function webGptStrengthOptionDiagnostics(control) {
  return webGptStrengthOptionCandidates(control)
    .map(elementLabel)
    .filter((label) => label && label.length <= 40)
    .slice(-20)
}

function findWebGptStrengthSlider(control) {
  // Radix may portal the new slider without setting aria-controls on its
  // trigger. Slider nodes are not menuitems and were omitted by the fallback.
  const candidates = [...webGptStrengthOptionCandidates(control), ...document.querySelectorAll('[role="slider"]')]
  return candidates.find((node) => {
    if (typeof node.getBoundingClientRect === 'function' && node.getBoundingClientRect().width === 0) return false
    const role = node?.getAttribute?.('role')
    const rawValue = node?.getAttribute?.('aria-valuenow')
    const value = rawValue === null || rawValue === undefined ? null : Number(rawValue)
    return role === 'slider' || Number.isInteger(value)
  }) || null
}

function findWebGptStrengthGateway(control) {
  return webGptStrengthOptionCandidates(control).find((node) => {
    if (node?.disabled || isWebGptPickerOption(node) && webGptStrengthFromNode(node)) return false
    const className = typeof node?.className === 'string'
      ? node.className
      : node?.getAttribute?.('class') || ''
    const label = elementLabel(node).toLowerCase()
    return className.includes('SliderControl') ||
      label.includes('thinking strength') ||
      label.includes('reasoning strength') ||
      label.includes('思考强度') ||
      label.includes('推理强度')
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
    let nextIndex = currentIndex
    for (let attempt = 0; attempt < 20 && nextIndex === currentIndex; attempt += 1) {
      await yieldWebGptUi()
      nextIndex = Number(slider.getAttribute?.('aria-valuenow'))
    }
    if (!Number.isInteger(nextIndex) || nextIndex === currentIndex) return false
    currentIndex = nextIndex
  }
  return currentIndex === targetIndex
}

function webGptControlOpenState(control) {
  return control?.getAttribute?.('data-state') === 'open' ||
    control?.getAttribute?.('aria-expanded') === 'true'
}

async function openWebGptStrengthControl(control, ready = () => false) {
  if (typeof PointerEvent === 'function' && typeof control?.dispatchEvent === 'function') {
    control.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerType: 'mouse',
      isPrimary: true
    }))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await yieldWebGptUi()
      if (webGptControlOpenState(control) || ready()) return
    }
  }

  control.click()
  await yieldWebGptUi()
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
  before ??= webGptStrengthFromNode(control) || control.innerText?.trim() || elementLabel(control)
  await openWebGptStrengthControl(
    control,
    () => Boolean(findWebGptStrengthOption(wanted, control) || findWebGptStrengthSlider(control))
  )

  let option = null
  let slider = null
  let gatewayOpened = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    slider = findWebGptStrengthSlider(control)
    if (slider) break
    if (!gatewayOpened) {
      const gateway = findWebGptStrengthGateway(control)
      if (gateway) {
        gateway.click()
        gatewayOpened = true
        await yieldWebGptUi()
        continue
      }
    }
    option = findWebGptStrengthOption(wanted, control)
    if (option) break
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
    const after = webGptStrengthFromSlider(slider) ||
      selectedWebGptStrengthFromOption(option) ||
      (afterControl ? selectedWebGptStrengthFromMenu(afterControl) : null) ||
      (afterControl ? (webGptStrengthFromNode(afterControl) || elementLabel(afterControl)) : null)
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

  const currentProjectMatches = Boolean(
    projectIdentity && projectIdentityFromUrl(location.href) === projectIdentity
  )
  const maxAnchorAttempts = currentProjectMatches ? 8 : 80
  for (let attempt = 0; attempt < maxAnchorAttempts; attempt += 1) {
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

  // A stable conversation URL is sufficient evidence for the Project identity.
  // If the new UI omits the sidebar anchor, navigate to the already-authorized
  // canonical Project home instead of treating presentation markup as authority.
  if (currentProjectMatches) {
    if (canonicalProjectHomeFromHref(location.href) !== projectUrl) {
      if (typeof location.assign === 'function') location.assign(projectUrl)
      else location.href = projectUrl
    }
    return {
      accepted: true,
      projectUrl,
      control: {
        kind: 'canonical-project-navigation',
        source: 'current-project-identity'
      }
    }
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

const PERSISTENT_MESSAGE_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function visibleNode(node) {
  if (!node) return false
  for (let current = node; current; current = current.parentElement) {
    if (['aside', 'nav'].includes(current.tagName?.toLowerCase()) || current.getAttribute?.('role') === 'complementary' ||
        current.getAttribute?.('data-testid') === 'sidebar' || current.getAttribute?.('aria-hidden') === 'true' ||
        current.hasAttribute?.('data-sidebar') || current.hasAttribute?.('hidden')) return false
  }
  const rects = node.getClientRects?.()
  if (rects && ![...rects].some(rect => rect.width > 0 && rect.height > 0)) return false
  for (let current = node; current; current = current.parentElement) {
    const style = globalThis.getComputedStyle?.(current)
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0')) return false
  }
  return true
}

function messageCollection() {
  const roots = [...document.querySelectorAll('main[data-app-shell-main-surface="browser"]')]
  if (roots.length > 1) return { messages: [], unreadable: true, root: null }
  const root = roots[0] ?? null
  const units = root ? [...root.querySelectorAll('[data-chatgpt-search-unit-key]')].filter(visibleNode) : []
  if (!units.length) return { messages: [], unreadable: false, root }
  const messages = []
  for (const node of units) {
    const ids = (node.getAttribute('data-chatgpt-search-message-ids') ?? '').split(' ')
    const unique = [...new Set(ids)]
    const searchTurn = node.closest('[data-content-search-turn-key]')
    const turn = searchTurn?.parentElement
    const bubbles = [...node.querySelectorAll('[data-user-message-bubble="true"]')]
    const headings = [...node.querySelectorAll('[data-conversation-role="assistant"]')]
    const bodies = [...node.querySelectorAll('[data-markdown-text-style="assistant-message"]')]
    const selections = [...node.querySelectorAll('[data-chatgpt-selection-message-id]')]
    const role = bubbles.length === 1 && !headings.length && !bodies.length && !selections.length ? 'user' :
      !bubbles.length && headings.length === 1 && bodies.length === 1 && selections.length === 1 ? 'assistant' : null
    const id = unique[0]
    if (node.closest('form, [role="dialog"], [data-testid="tool-approval-card"], [data-composer-body], [data-composer-input]') ||
        !role || unique.length !== 1 || !ids.every(value => PERSISTENT_MESSAGE_UUID.test(value)) ||
        !turn || !PERSISTENT_MESSAGE_UUID.test(turn.getAttribute?.('data-turn-key') ?? '') ||
        node.closest('[data-turn-key]') !== turn || node.closest('main[data-app-shell-main-surface="browser"]') !== root ||
        (role === 'user' && id !== turn.getAttribute('data-turn-key')) ||
        (role === 'assistant' && (selections[0].getAttribute('data-chatgpt-selection-message-id') !== id ||
          bodies[0].parentElement !== selections[0])) ||
        [...bubbles, ...headings, ...bodies, ...selections].some(child => child.closest('[data-chatgpt-search-unit-key]') !== node)) {
      return { messages: [], unreadable: true, root }
    }
    messages.push({ node, role, id, turn, searchTurn, body: role === 'user' ? bubbles[0] : bodies[0] })
  }
  for (const message of messages) {
    const peers = messages.filter(other => other.turn === message.turn)
    const anchor = peers.filter(other => other.role === 'user')
    if (anchor.length !== 1 || peers.filter(other => other.role === 'assistant').length > 1 ||
        peers.some(other => other.searchTurn !== message.searchTurn) ||
        (message.role === 'assistant' && ((anchor[0].node.compareDocumentPosition(message.node) & 5) !== 4)) ||
        messages.some(other => other !== message && other.id === message.id)) return { messages: [], unreadable: true, root }
  }
  return { messages, unreadable: false, root }
}

function messageMetadata(node) {
  return node?.getAttribute?.('data-chatgpt-search-unit-key') !== null
    ? messageCollection().messages.find(message => message.node === node) ?? null : null
}

function persistentMessageId(node) {
  if (!node) return null
  if (node.getAttribute?.('data-chatgpt-search-unit-key') != null) return messageMetadata(node)?.id ?? null
  return node.getAttribute?.('data-message-id') || null
}

function messageTurn(node) {
  return messageMetadata(node)?.turn ?? node?.closest?.('[data-testid^="conversation-turn-"]') ?? null
}

function messagesForRole(role) {
  const collection = messageCollection()
  if (collection.unreadable) return []
  if (collection.messages.length) return collection.messages.filter(message => message.role === role).map(message => message.node)
  return [...(collection.root ?? document).querySelectorAll('[data-message-author-role="' + role + '"]')].filter(visibleNode)
}

function assistantMessages() { return messagesForRole('assistant') }
function userMessages() { return messagesForRole('user') }

function followsUser(anchor, assistant) {
  const relation = anchor?.compareDocumentPosition?.(assistant)
  if (typeof relation !== 'number' || (relation & 5) !== 4) return false
  const proof = messageMetadata(anchor)
  return !proof || messageMetadata(assistant)?.turn === proof.turn
}

function currentThreadNodes(selector, includeOtherForms = false) {
  const collection = messageCollection()
  if (collection.unreadable) return []
  const scope = collection.root ?? document
  const currentTurn = collection.messages.filter(message => message.role === 'user').at(-1)?.turn
  const composerForm = findPromptEditor()?.closest?.('form')
  return [...scope.querySelectorAll(selector)].filter(node => {
    const turn = node.closest?.('[data-turn-key]')
    const form = node.closest?.('form')
    const foreignControl = !includeOtherForms && node.closest?.('[role="dialog"], [data-testid="tool-approval-card"], [data-message-author-role], [data-chatgpt-search-unit-key], [data-markdown-text-style="assistant-message"]')
    return !foreignControl && visibleNode(node) && (!currentTurn || !turn || turn === currentTurn) && (includeOtherForms || !composerForm || !form || form === composerForm)
  })
}

function terminalActionAvailable(message) {
  const proof = messageMetadata(message)
  const turn = messageTurn(message)
  if (!turn) return false
  if (!proof) {
    const selector = '[data-testid="copy-turn-action-button"], [data-testid="feedback-turn-action-button"], button[aria-label*="Copy response" i], button[aria-label*="复制回复"]'
    const candidates = typeof turn.querySelectorAll === 'function' ? [...turn.querySelectorAll(selector)] : [turn.querySelector?.(selector)]
    return candidates.some(button => visibleNode(button) &&
      (typeof button.closest !== 'function' || button.closest('[data-testid^="conversation-turn-"]') === turn))
  }
  return [...turn.querySelectorAll('button')].some(button => visibleNode(button) &&
    button.closest('[data-turn-key]') === turn &&
    !button.closest('[data-user-message-bubble="true"]') &&
    !messageCollection().messages.some(candidate => candidate.role === 'user' && candidate.node.contains(button)) &&
    (['copy-turn-action-button', 'feedback-turn-action-button'].includes(button.getAttribute('data-testid')) ||
      ['Copy response', 'Regenerate response', 'Bad response', '复制', '复制回复', '重新生成回复', '回复不佳'].includes(button.getAttribute('aria-label'))))
}

function nodeText(node) {
  return (node?.innerText || node?.textContent || '').trim()
}

function userMessageText(node) {
  const proof = messageMetadata(node)
  if (proof) {
    const candidates = [...node.querySelectorAll('[data-search-result-target]')]
    if (candidates.length) {
      if (candidates.length !== 1) return ''
      const root = candidates[0]
      if (root.closest('[data-chatgpt-search-unit-key]') !== node ||
          root.closest('[data-user-message-bubble="true"]') !== proof.body ||
          root.closest('form, [role="dialog"], [data-testid="tool-approval-card"], [data-composer-body], [data-composer-input]')) return ''
      return nodeText(root)
    }
    if (proof.body.querySelector('[data-thread-find-skip="true"]')) return ''
    return nodeText(proof.body)
  }
  const content = node?.querySelector?.('[data-testid="collapsible-user-message-content"]')
  return nodeText(content || node)
}

function turnKey(node) {
  const proof = messageMetadata(node)
  if (proof) return proof.id
  const turn = messageTurn(node)
  return turn?.getAttribute?.('data-testid') || persistentMessageId(node)
}

function bodySnapshot(message) {
  const shellText = nodeText(message)
  if (!message) return { bodyText: '', bodyComplete: false, shellText }

  // Test doubles from older fixtures do not model element traversal. Real DOM
  // nodes always do; preserve those fixtures without weakening the browser path.
  if (typeof message.querySelector !== 'function') {
    return { bodyText: shellText, bodyComplete: Boolean(shellText), shellText }
  }

  const root = messageMetadata(message)?.body ?? message.querySelector(
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
      const following = assistants.filter(assistant => followsUser(anchor, assistant))
      last = following.at(-1) ?? null
    }
  }

  const present = normalizedPrompt
    ? Boolean(anchor && last)
    : assistants.length > Number(baselineAssistantCount ?? 0) && Boolean(last)
  const body = bodySnapshot(present ? last : null)
  const terminalActions = terminalActionAvailable(last)

  return {
    url: location.href,
    userTurnKey: anchor ? turnKey(anchor) : null,
    assistantTurnKey: present ? turnKey(last) : null,
    present,
    bodyText: body.bodyText,
    bodyComplete: body.bodyComplete,
    shellText: body.shellText,
    continuationAvailable: ['INTERRUPTED', 'RESUME_UNAVAILABLE'].includes(getComposerMode()),
    terminalActionAvailable: terminalActions
  }
}

function readConversationStateObservation(expectedUserMessageId, allowLatestUser = false) {
  const users = userMessages()
  const assistants = assistantMessages()
  const expectedAnchor = typeof expectedUserMessageId === 'string' && expectedUserMessageId
    ? users.find(user => persistentMessageId(user) === expectedUserMessageId) ?? null
    : null
  let anchor = expectedAnchor
  if (allowLatestUser) {
    const latest = users.at(-1) ?? null
    const relation = expectedAnchor?.compareDocumentPosition?.(latest)
    const provenLatest = expectedAnchor && latest && (latest === expectedAnchor ||
      (typeof relation === 'number' && (relation & 4) !== 0 && (relation & 1) === 0))
    const persistentId = persistentMessageId(latest)
    anchor = provenLatest && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(persistentId ?? '') ? latest : null
  }
  if (!anchor) {
    return {
      ready: true, url: location.href, readable: false,
      userMessageId: null, assistantMessageId: null, assistantText: null,
      generating: null, terminal: null, body: 'unknown', humanGate: null,
      ...(allowLatestUser && !expectedAnchor ? { reason: 'human_turn_anchor_unavailable' } : {})
    }
  }

  const newerUser = users.some(user => user !== anchor && (() => {
    const relation = anchor?.compareDocumentPosition?.(user)
    return typeof relation === 'number' && (relation & 4) !== 0
  })())
  if (newerUser) {
    return {
      ready: true, url: location.href, readable: false,
      userMessageId: persistentMessageId(anchor),
      assistantMessageId: null, assistantText: null,
      generating: null, terminal: null, body: 'unknown', humanGate: null
    }
  }

  const following = assistants.filter(assistant => followsUser(anchor, assistant))
  const assistant = following.at(-1) ?? null
  const body = bodySnapshot(assistant)
  const turn = messageTurn(assistant)
  const finalActionAvailable = terminalActionAvailable(assistant)
  const mode = getComposerMode()
  const generating = mode === 'GENERATING'
  const assistantText = assistant ? (body.bodyText || '') : ''
  const approvalScope = allowLatestUser ? turn : document
  const liveApproval = messageCollection().root ? currentThreadNodes('[data-testid="tool-approval-card"]', true).length > 0 :
    Boolean(approvalScope?.querySelector?.('[data-testid="tool-approval-card"]'))
  const humanGate = Boolean(assistant || !allowLatestUser) && (liveApproval ||
    /(?:^|\n)\[SUPERVISOR_STATE\s*:\s*NEED_INPUT\]\s*$/.test(assistantText))
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
    userMessageId: persistentMessageId(anchor),
    assistantMessageId: persistentMessageId(assistant),
    assistantText,
    generating,
    terminal: generating || ['INTERRUPTED', 'RESUME_UNAVAILABLE'].includes(mode) ? false : finalActionAvailable,
    body: bodyState,
    humanGate
  }
}

function findStopButton() {
  const direct = currentThreadNodes('[data-testid="stop-button"]')[0]
  if (direct && visibleNode(direct)) return direct
  return currentThreadNodes('button').find((button) => {
    const label = (button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase()
    return label.includes('stop streaming') ||
      label.includes('stop generating') ||
      label.includes('stop responding') ||
      label.includes('stop response') ||
      label.includes('停止生成') ||
      label.includes('停止回答') ||
      label === 'stop'
  }) ?? null
}

function isGenerating() {
  return Boolean(findStopButton())
}

function nullableMessageId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function handleStop(message) {
  const expected = message?.expected
  if (!expected || typeof expected !== 'object') throw new Error('stop requires expected message identity')
  const expectedUserMessageId = nullableMessageId(expected.userMessageId)
  const expectedAssistantMessageId = nullableMessageId(expected.assistantMessageId)
  const observation = readConversationStateObservation(expectedUserMessageId)
  const userMessageId = nullableMessageId(observation.userMessageId)
  const assistantMessageId = nullableMessageId(observation.assistantMessageId)
  if (observation.humanGate === true) throw new Error('need_input')
  if (observation.readable !== true || !expectedUserMessageId || userMessageId !== expectedUserMessageId || assistantMessageId !== expectedAssistantMessageId) {
    throw new Error('stale_intent')
  }

  const stop = findStopButton()
  if (!stop || stop.disabled === true || stop.getAttribute?.('aria-disabled') === 'true') {
    throw new Error('generation is not stoppable')
  }
  stop.click()

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isGenerating()) {
      const after = readConversationStateObservation(expectedUserMessageId)
      if (after.readable !== true) {
        const error = new Error('stop completed but exact current turn is no longer observable')
        error.deliveryUncertain = true
        throw error
      }
      return {
        accepted: true,
        url: location.href,
        userMessageId: nullableMessageId(after.userMessageId),
        assistantMessageId: nullableMessageId(after.assistantMessageId),
        assistantText: after.assistantText || ''
      }
    }
    await sleep(50)
  }
  const error = new Error('Stop effect could not be confirmed')
  error.deliveryUncertain = true
  throw error
}

function getComposerMode() {
  const buttons = currentThreadNodes('button')
  const labels = buttons.map((button) => (
    button.getAttribute('aria-label') || button.textContent || ''
  ).trim().toLowerCase())
  const alerts = currentThreadNodes('[role="alert"]').map(nodeText)
  const statuses = currentThreadNodes('[role="status"]').map(nodeText)
  const frontendNotices = [...alerts, ...statuses]
  const resumeUnavailable = labels.some((label) =>
    label.includes('resume stream unavailable') || label.includes('unable to resume stream')
  ) || frontendNotices.some((text) =>
    /resume stream unavailable|unable to resume stream/i.test(text)
  )
  if (resumeUnavailable) return 'RESUME_UNAVAILABLE'
  const hasError = labels.some((label) =>
    ['try again', 'retry', '重试'].includes(label)
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
      const interrupted = ['INTERRUPTED', 'RESUME_UNAVAILABLE'].includes(mode)
      const terminalBoundary = observation.terminalActionAvailable || interrupted
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

      const complete = !interrupted && observation.present && observation.bodyComplete
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
            reason: mode === 'RESUME_UNAVAILABLE'
              ? 'resume_stream_unavailable'
              : mode === 'INTERRUPTED'
                ? 'generation_interrupted'
                : 'assistant_body_incomplete',
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
  const userMessageId = persistentMessageId(user) || ''
  const assistantMessageId = persistentMessageId(assistant) || ''
  const userPending = Boolean(user && (!assistant || ((assistant.compareDocumentPosition?.(user) || 0) & 4)))
  const turn = messageTurn(assistant)
  const finalized = terminalActionAvailable(assistant)
  const editor = findPromptEditor()
  const draft = composerDraft(editor)
  const text = bodySnapshot(assistant).bodyText || nodeText(assistant)
  const liveApprovalGate = currentThreadNodes('[data-testid="tool-approval-card"]', true).length > 0
  const textualHumanGate = /(?:^|\n)\[SUPERVISOR_STATE\s*:\s*NEED_INPUT\]\s*$/.test(text)
  const needsInput = liveApprovalGate || (requireTextHumanGate && textualHumanGate)
  const busy = isGenerating() || turn?.getAttribute?.('aria-busy') === 'true' || Boolean(turn?.querySelector?.('[aria-busy="true"]'))
  const reason = messageCollection().unreadable ? 'persistent_turn_identity_unavailable' : userPending ? 'user_turn_pending' : busy ? 'assistant_active' : needsInput ? 'need_input' :
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
  assertExpectedComposerMode(message.expectedMode)
  const observation = message.guarded === true ? writerObservation(null, !authoritativeState, !authoritativeState) : null
  if (observation) assertWriterObservation(observation, message.expected)
  setPromptText(editor, message.text)
  if (observation) {
    const ownedDraft = composerDraft(editor)
    if (!ownedDraft.trim()) throw new Error('composer_changed')
    preparedSend = { turnId: message.turnId, text: ownedDraft, stamp: observation.stamp,
      expected: message.expected, expectedMode: message.expectedMode, authoritativeState }
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
    if (message.expectedMode !== undefined && message.expectedMode !== prepared.expectedMode) throw new Error('prepared_mode_mismatch')
    assertExpectedComposerMode(prepared.expectedMode)
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

async function reportContentEffectCompletion(completion) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const acknowledgement = await chrome.runtime.sendMessage({ kind: 'content_effect_complete', effect: completion.effect })
      if (acknowledgement?.settled === true && acknowledgement.token === completion.effect.token) {
        if (contentEffects.completed.get(completion.effect.token) === completion) contentEffects.completed.delete(completion.effect.token)
        return
      }
    } catch {}
    if (attempt < 7) await sleep(250)
  }
}

function onSidecarMessage(message, sender, sendResponse) {
  if (contentDisposed) return
  const completionProbe = ['sidecar_ping', 'sidecar_effect_document', 'conversation_observe', 'conversation_state_observe', 'conversation_snapshot'].includes(message?.type)
  const completions = completionProbe ? [...contentEffects.completed.values()] : []
  if (completions.length) {
    // A read-only probe can recover exhausted delivery retries. Its response
    // waits for completion ACKs so the owner can re-read the durable journal.
    void Promise.all(completions.map(reportContentEffectCompletion)).then(() => {
      processSidecarMessage(message, sender, sendResponse)
    }).catch(() => sendResponse({ ready: false }))
    return true
  }
  return processSidecarMessage(message, sender, sendResponse)
}

function processSidecarMessage(message, sender, sendResponse) {
  if (contentDisposed) return
  if (message?.type === 'sidecar_effect_document') {
    void chrome.runtime.sendMessage({ kind: 'content_effect_document', token: message.token }).then(identity => {
      if (identity?.token === message.token && Number.isInteger(identity.tabId) &&
          typeof identity.documentId === 'string' && /^[0-9a-f]{32}$/i.test(identity.documentId)) {
        contentEffects.documentId = identity.documentId
        contentEffects.tabId = identity.tabId
        sendResponse(identity)
      } else sendResponse({ ready: false })
    }).catch(() => sendResponse({ ready: false }))
    return true
  }
  const effect = message?.contentEffect
  if (!effect) return dispatchSidecarMessage(message, sender, sendResponse)
  if (effect.version !== 1 || typeof effect.token !== 'string' || !effect.token || effect.token.length > 256 ||
      effect.documentId !== contentEffects.documentId || effect.tabId !== contentEffects.tabId ||
      effect.method !== message.type || !journaledMethods.has(message.type)) {
    sendResponse({ accepted: false, prepared: false, switched: false, error: 'content_effect_document_mismatch' })
    return true
  }
  const existing = contentEffects.operations.get(effect.token)
  if (existing) {
    if (JSON.stringify(existing.effect) !== JSON.stringify(effect)) sendResponse({ accepted: false, error: 'content_effect_identity_conflict' })
    else void existing.promise.then(sendResponse)
    return true
  }
  const promise = new Promise(resolve => {
    let answered = false
    const complete = result => {
      if (answered) return
      answered = true
      const response = { ...result, contentEffectSettled: effect }
      const completion = { effect, response }
      // This callback runs only after the handler's effect-bearing awaits end.
      // The outbox survives listener reinjection; only the completion is retried.
      contentEffects.completed.set(effect.token, completion)
      resolve(response)
      void reportContentEffectCompletion(completion)
      try { sendResponse(response) } catch {}
    }
    try {
      const keepOpen = dispatchSidecarMessage(message, sender, complete)
      if (keepOpen !== true && !answered) complete({ accepted: false, error: 'unsupported_content_effect' })
    } catch (error) {
      complete({ accepted: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  contentEffects.operations.set(effect.token, { effect, promise })
  return true
}

function dispatchSidecarMessage(message, _sender, sendResponse) {
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
    const observation = writerObservation(null, message.authoritativeState !== true, message.authoritativeState !== true)
    if (message.authoritativeState === true) {
      const current = readConversationStateObservation(observation.userMessageId, true)
      observation.readable = current.readable === true && (current.assistantMessageId === null ||
        (typeof current.assistantMessageId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(current.assistantMessageId)))
      if (observation.readable) {
        observation.userMessageId = current.userMessageId
        observation.assistantMessageId = current.assistantMessageId
      }
    }
    sendResponse(observation)
    return
  }

  if (message?.type === 'conversation_state_observe') {
    sendResponse(readConversationStateObservation(message.expectedUserMessageId, message.allowLatestUser === true))
    return
  }

  if (message?.type === 'conversation_snapshot') {
    const last = assistantMessages().at(-1)
    sendResponse({
      ready: true,
      url: location.href,
      generating: isGenerating(),
      assistantText: bodySnapshot(last).bodyText
    })
    return
  }

  if (message?.type === 'conversation_mode_select') {
    void selectComposerMode(message.mode)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        selected: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    return true
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

  if (message?.type === 'conversation_stop') {
    void handleStop(message)
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
for (const completion of contentEffects.completed.values()) void reportContentEffectCompletion(completion)
void resumePendingTurn()
runHashShiftProbe()
})()
