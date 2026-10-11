import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dragHandlers } from './fixtures/drag-harness.ts'
import {
  AGENT_STRIP_WIDTH, BALL_WINDOW_SIZE, CHROME_INSET, FloatingPlacement,
  ballOriginFromWindow, type DisplayPair, type Rect,
} from '../src/geometry.ts'

function fixture(displays: DisplayPair[], x: number, y: number, scale = 1) {
  let bounds: Rect = { x: x - CHROME_INSET, y: y - CHROME_INSET, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE }
  const messages: { channel: string; state: Record<string, unknown> }[] = []
  const enclose = (size: number) => Math.ceil(Math.ceil(size * scale - 1e-9) / scale - 1e-9)
  const window = {
    getBounds: () => ({ ...bounds }),
    setBounds(next: Rect) { bounds = { ...next, width: enclose(next.width), height: enclose(next.height) } },
    isDestroyed: () => false,
    webContents: { send(channel: string, state: Record<string, unknown>) { messages.push({ channel, state }) } },
  }
  const placement = new FloatingPlacement(window, (point) => {
    const display = displays.find(({ bounds: area }) => point.x >= area.x && point.x < area.x + area.width
      && point.y >= area.y && point.y < area.y + area.height)
    assert.ok(display, `point ${JSON.stringify(point)} must be on a display`)
    return display
  }, () => displays.map(({ bounds: area }) => area))
  return { window, placement, messages }
}

describe('system cursor with expansion anchors', () => {
  for (const scale of [1, 1.2, 1.5]) {
    it(`grabs the drawn ball after a strip-constrained expand at scale ${scale}`, () => {
      const area = { x: 0, y: 0, width: 600, height: 900 }
      const f = fixture([{ bounds: area, workArea: area }], 188, 400, scale)
      f.placement.setStrip(AGENT_STRIP_WIDTH)
      const expanded = f.placement.setExpanded(true)
      const drawn = ballOriginFromWindow(f.window.getBounds(), expanded)
      assert.notEqual(drawn.x, 188, 'the panel clamp must displace the drawn ball from the saved anchor')
      f.placement.press({ x: drawn.x + 30, y: drawn.y + 30 })
      f.placement.beginDrag()
      f.placement.dragTo({ x: drawn.x + 50, y: drawn.y + 40 }, false)
      f.placement.setExpanded(false)
      assert.equal(f.window.getBounds().x + CHROME_INSET, drawn.x + 20)
      assert.equal(f.window.getBounds().y + CHROME_INSET, drawn.y + 10)
    })
  }

  it('notifies the renderer of the new panel and strip direction during a cross-screen signal drag', () => {
    const left = { x: -1463, y: 0, width: 1463, height: 914 }
    const primary = { x: 0, y: 0, width: 1920, height: 1080 }
    const f = fixture([{ bounds: left, workArea: left }, { bounds: primary, workArea: primary }], 1848, 563)
    f.placement.setStrip(AGENT_STRIP_WIDTH)
    assert.equal(f.placement.setExpanded(true).horizontal, 'left')
    const handlers = dragHandlers(f.window, f.placement)
    const event = { sender: f.window.webContents }
    handlers.cursor({ x: 1878, y: 593 })
    handlers.invoke('orb:drag-press', event)
    handlers.invoke('orb:drag-begin', event)
    handlers.cursor({ x: -791, y: 198 })
    handlers.invoke('orb:drag-move', event, false)
    const update = f.messages.at(-1)
    assert.ok(update)
    assert.equal(update.channel, 'orb:expand-state')
    assert.equal(update.state.horizontal, 'right')
    assert.equal(update.state.vertical, 'down')
    assert.equal(update.state.strip, AGENT_STRIP_WIDTH)
    assert.deepEqual(ballOriginFromWindow(f.window.getBounds(), { horizontal: 'right', vertical: 'down' }), { x: -821, y: 168 })
  })

  it('uses the main-process cursor and ignores another sender and renderer coordinate payloads', async () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 }
    const f = fixture([{ bounds: area, workArea: area }], 400, 300)
    const handlers = dragHandlers(f.window, f.placement)
    const event = { sender: f.window.webContents }
    handlers.cursor({ x: 430, y: 330 })
    handlers.invoke('orb:drag-press', event)
    handlers.invoke('orb:drag-begin', event)
    const before = f.window.getBounds()
    handlers.cursor({ x: 600, y: 420 })
    handlers.invoke('orb:drag-move', { sender: {} }, true)
    assert.deepEqual(f.window.getBounds(), before)
    handlers.invoke('orb:drag-move', event, { x: -9000, y: -9000 })
    assert.equal(f.window.getBounds().x + CHROME_INSET, 570)
    assert.equal(f.window.getBounds().y + CHROME_INSET, 390)
    await handlers.invoke('orb:drag-end', event, false)
    assert.equal(f.window.getBounds().x + CHROME_INSET, 570)
  })
})
