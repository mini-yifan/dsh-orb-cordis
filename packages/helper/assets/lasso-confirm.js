const api = window.dshLasso?.confirm
const stage = document.querySelector('#stage')
const selection = document.querySelector('#selection')
const dimTop = document.querySelector('#dim-top')
const dimBottom = document.querySelector('#dim-bottom')
const dimLeft = document.querySelector('#dim-left')
const dimRight = document.querySelector('#dim-right')
const handles = [...document.querySelectorAll('.handle')]
const bar = document.querySelector('#bar')
const sendButton = document.querySelector('#send')
const translateButton = document.querySelector('#translate')
const copyButton = document.querySelector('#copy')
const errorText = document.querySelector('#error')
const hint = document.querySelector('#hint')

const MIN_SIDE = 48
let display = { x: 0, y: 0, width: 1, height: 1 }
let rect = { x: 0, y: 0, width: 1, height: 1 }
let gesture
let busy = false
let doneTimer
let locale = 'zh'

const LABELS = {
  zh: { send: '发给 Agent', translate: '翻译', copy: '复制', hint: '拖动调整 · Esc 取消' },
  en: { send: 'Send to Agent', translate: 'Translate', copy: 'Copy', hint: 'Drag to adjust · Esc to cancel' },
}

function localRect(globalRect) {
  return {
    x: globalRect.x - display.x,
    y: globalRect.y - display.y,
    width: globalRect.width,
    height: globalRect.height,
  }
}

function globalRect() {
  return {
    x: rect.x + display.x,
    y: rect.y + display.y,
    width: rect.width,
    height: rect.height,
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function layout() {
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  dimTop.style.cssText = `left:0;top:0;width:${display.width}px;height:${Math.max(0, rect.y)}px`
  dimBottom.style.cssText = `left:0;top:${bottom}px;width:${display.width}px;height:${Math.max(0, display.height - bottom)}px`
  dimLeft.style.cssText = `left:0;top:${rect.y}px;width:${Math.max(0, rect.x)}px;height:${rect.height}px`
  dimRight.style.cssText = `left:${right}px;top:${rect.y}px;width:${Math.max(0, display.width - right)}px;height:${rect.height}px`
  selection.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`
  const positions = {
    nw: [rect.x - 6, rect.y - 6],
    ne: [right - 6, rect.y - 6],
    sw: [rect.x - 6, bottom - 6],
    se: [right - 6, bottom - 6],
  }
  for (const handle of handles) {
    const [x, y] = positions[handle.dataset.corner]
    handle.style.cssText = `left:${x}px;top:${y}px`
  }
  layoutBar()
}

function layoutBar() {
  const width = bar.offsetWidth
  const height = bar.offsetHeight
  const gap = 8
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  let x = right - width
  let y = bottom + gap
  if (y + height > display.height - gap) y = rect.y - height - gap
  if (y < gap) y = clamp(bottom - height - gap, gap, display.height - height - gap)
  x = clamp(x, gap, display.width - width - gap)
  bar.style.left = `${x}px`
  bar.style.top = `${y}px`
}

function update(next) {
  rect = next
  layout()
}

function move(dx, dy) {
  update({
    x: clamp(rect.x + dx, 0, display.width - rect.width),
    y: clamp(rect.y + dy, 0, display.height - rect.height),
    width: rect.width,
    height: rect.height,
  })
}

function resize(corner, dx, dy) {
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.width
  let bottom = rect.y + rect.height
  if (corner === 'nw' || corner === 'sw') left = Math.min(left + dx, right - MIN_SIDE)
  if (corner === 'ne' || corner === 'se') right = Math.max(right + dx, left + MIN_SIDE)
  if (corner === 'nw' || corner === 'ne') top = Math.min(top + dy, bottom - MIN_SIDE)
  if (corner === 'sw' || corner === 'se') bottom = Math.max(bottom + dy, top + MIN_SIDE)
  left = clamp(left, 0, display.width - MIN_SIDE)
  top = clamp(top, 0, display.height - MIN_SIDE)
  right = clamp(right, left + MIN_SIDE, display.width)
  bottom = clamp(bottom, top + MIN_SIDE, display.height)
  update({ x: left, y: top, width: right - left, height: bottom - top })
}

function beginGesture(event, mode, corner) {
  if (busy) return
  gesture = {
    mode,
    corner,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    rect,
  }
  event.currentTarget.setPointerCapture?.(event.pointerId)
  event.preventDefault()
  event.stopPropagation()
}

selection.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  beginGesture(event, 'move')
})
for (const handle of handles) {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    beginGesture(event, 'resize', handle.dataset.corner)
  })
}

window.addEventListener('pointermove', (event) => {
  if (gesture === undefined || event.pointerId !== gesture.pointerId) return
  const dx = event.clientX - gesture.startX
  const dy = event.clientY - gesture.startY
  rect = gesture.rect
  if (gesture.mode === 'move') move(dx, dy)
  else resize(gesture.corner, dx, dy)
})

function endGesture(event) {
  if (gesture === undefined) return
  if (event !== undefined && event.pointerId !== gesture.pointerId) return
  gesture = undefined
}

window.addEventListener('pointerup', endGesture)
window.addEventListener('pointercancel', endGesture)

stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (event.target === stage || event.target.classList.contains('dim')) api?.cancel()
})

function setBusy(next, action) {
  busy = next
  for (const button of [sendButton, translateButton, copyButton]) {
    button.disabled = next
    button.classList.toggle('busy', next && button === action)
  }
  if (!next) {
    for (const button of [sendButton, translateButton, copyButton]) button.classList.remove('busy')
  }
}

function showError(message) {
  errorText.hidden = false
  errorText.textContent = message
}

function clearTimers() {
  if (doneTimer !== undefined) {
    clearTimeout(doneTimer)
    doneTimer = undefined
  }
}

function act(action) {
  if (busy) return
  errorText.hidden = true
  setBusy(true, action === 'copy' ? copyButton : action === 'translate' ? translateButton : sendButton)
  // Hide the frame's chrome before the Host grabs the pixels; the dim and the
  // transparent selection hole stay, which is exactly the highlight image.
  document.body.classList.add('capturing')
  setTimeout(() => {
    api?.action({ action, rect: globalRect(), display })
  }, 60)
}

sendButton.addEventListener('click', (event) => {
  event.stopPropagation()
  act('send')
})
translateButton.addEventListener('click', (event) => {
  event.stopPropagation()
  act('translate')
})
copyButton.addEventListener('click', (event) => {
  event.stopPropagation()
  act('copy')
})

function applyLabels(next) {
  locale = next === 'en' ? 'en' : 'zh'
  const labels = LABELS[locale]
  sendButton.textContent = labels.send
  translateButton.textContent = labels.translate
  copyButton.textContent = labels.copy
  hint.textContent = labels.hint
}

api?.onShow((payload) => {
  if (payload === null || typeof payload !== 'object') return
  display = payload.display ?? display
  rect = localRect(payload.rect)
  rect.width = Math.max(MIN_SIDE, Math.min(rect.width, display.width))
  rect.height = Math.max(MIN_SIDE, Math.min(rect.height, display.height))
  rect.x = clamp(rect.x, 0, display.width - rect.width)
  rect.y = clamp(rect.y, 0, display.height - rect.height)
  document.body.classList.toggle('dark', payload.dark === true)
  document.body.classList.remove('capturing')
  clearTimers()
  setBusy(false)
  copyButton.classList.remove('done')
  errorText.hidden = true
  applyLabels(payload.locale)
  layout()
  requestAnimationFrame(layout)
})

api?.onAppearance((payload) => {
  if (payload === null || typeof payload !== 'object') return
  document.body.classList.toggle('dark', payload.dark === true)
  applyLabels(payload.locale)
})

api?.onResult((payload) => {
  if (payload === null || typeof payload !== 'object') return
  document.body.classList.remove('capturing')
  setBusy(false)
  if (payload.ok === true) {
    if (payload.action === 'copy') {
      copyButton.classList.add('done')
      copyButton.textContent = '✓'
      clearTimers()
      doneTimer = setTimeout(() => {
        copyButton.classList.remove('done')
        applyLabels(locale)
      }, 1200)
    }
    return
  }
  showError(typeof payload.message === 'string' && payload.message !== '' ? payload.message : '操作失败，请重试')
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    api?.cancel()
  }
})

window.addEventListener('resize', layout)
