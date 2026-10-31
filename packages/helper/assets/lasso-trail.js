const canvas = document.querySelector('#trail')
const context = canvas.getContext('2d')
const api = window.dshLasso?.trail
let display = { x: 0, y: 0, width: 1, height: 1 }
let points = []
let opacity = 1
let fading = false
let frame = 0

function resize() {
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(window.innerWidth * ratio))
  canvas.height = Math.max(1, Math.round(window.innerHeight * ratio))
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  draw()
}

function local(point) {
  return { x: point.x - display.x, y: point.y - display.y }
}

function draw() {
  context.clearRect(0, 0, window.innerWidth, window.innerHeight)
  if (points.length < 2 || opacity <= 0.01) return
  context.save()
  context.globalAlpha = opacity
  context.strokeStyle = '#3b82f6'
  context.lineWidth = 3
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  const first = local(points[0])
  context.moveTo(first.x, first.y)
  for (const point of points.slice(1)) {
    const next = local(point)
    context.lineTo(next.x, next.y)
  }
  context.stroke()
  context.restore()
}

function fade() {
  if (fading) return
  fading = true
  const tick = () => {
    opacity = Math.max(0, opacity - 0.12)
    draw()
    if (opacity > 0.01) frame = requestAnimationFrame(tick)
    else {
      fading = false
      points = []
      opacity = 1
      draw()
    }
  }
  frame = requestAnimationFrame(tick)
}

function reset() {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  fading = false
  opacity = 1
  points = []
  draw()
}

api?.onShow((payload) => {
  if (payload === null || typeof payload !== 'object') return
  display = payload.display ?? display
  reset()
  if (payload.point) {
    points = [{ x: payload.point.x, y: payload.point.y }]
    draw()
  }
})

api?.onPoint((point) => {
  if (point === null || typeof point !== 'object') return
  points.push({ x: point.x, y: point.y })
  draw()
})

api?.onFade((payload) => {
  if (Array.isArray(payload) && payload.length > 0) points = payload
  fade()
})

api?.onReject((payload) => {
  if (Array.isArray(payload) && payload.length > 0) points = payload
  context.save()
  context.globalAlpha = 1
  context.strokeStyle = '#ef4444'
  context.lineWidth = 3
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  const first = local(points[0])
  context.moveTo(first.x, first.y)
  for (const point of points.slice(1)) {
    const next = local(point)
    context.lineTo(next.x, next.y)
  }
  context.stroke()
  context.restore()
  fade()
})

window.addEventListener('resize', resize)
resize()
