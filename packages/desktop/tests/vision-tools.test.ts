import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { registerVisionTools } from '../src/vision.ts'

/**
 * These tests drive the two visual tools through their real execute paths with a
 * fake context, so the guard messages the model sees are the ones asserted here.
 * The CLI is never started: a fake `llm` declares image support and the screen
 * listing is served by stubbing the tool module's own window list through a
 * tiny fake backend is not possible, so instead the tests cover the decisions
 * that happen before and after any CLI call — the parts that are pure logic.
 */

interface ToolLike {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: Record<string, unknown>) => { type: string }[] }
}

function harness(options: { images?: boolean, coordinateClick?: boolean } = {}) {
  const tools = new Map<string, ToolLike>()
  const ctx = {
    tools: {
      register(tool: ToolLike) {
        tools.set(tool.name, tool)
      },
    },
    effect() {},
    get(name: string) {
      if (name !== 'llm') return undefined
      return {
        async resolveModelInfo() {
          return options.images === false ? { inputModalities: [] } : { inputModalities: ['text', 'image'] }
        },
      }
    },
    attachments: {
      async saveImage() {
        return {
          attachmentId: 'sha256:abc',
          mediaType: 'image/png',
          bytes: 10,
          width: 100,
          height: 50,
          name: 'desktop-window-w-1',
        }
      },
    },
  }
  const config = { ...resolveConfig(), ...options.coordinateClick === false ? { coordinateClick: false } : {} }
  registerVisionTools(ctx as never, config)
  return { tools, ctx }
}

const exec = (id = 'agent-1') => ({
  agent: {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) },
  },
  signal: new AbortController().signal,
})

test('both visual tools register under stable names', () => {
  const { tools } = harness()
  assert.deepEqual([...tools.keys()].sort(), ['desktop_click_xy', 'desktop_see'])
})

test('a click without a picture is refused before any input is sent', async () => {
  const { tools } = harness()
  const tool = tools.get('desktop_click_xy')
  assert.ok(tool)
  const value = await tool.execute({ x: 10, y: 20 }, exec())
  assert.match(String(value.text), /^NO_OBSERVATION/)
})

test('a route without image input cannot use the visual fallback', async () => {
  const { tools } = harness({ images: false })
  const tool = tools.get('desktop_see')
  assert.ok(tool)
  await assert.rejects(
    () => tool.execute({ window_id: 'w-1' }, exec()),
    /needs a model that declares image input/,
  )
})

test('the picture is rendered as an image block, not as JSON text', async () => {
  const { tools } = harness()
  const tool = tools.get('desktop_see')
  assert.ok(tool)
  const blocks = tool.output.render({}, {
    text: 'looked',
    window_id: 'w-1',
    image: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 100, height: 50 },
  })
  assert.deepEqual(blocks.map(block => block.type), ['text', 'image'])
})

test('a picture without an image value still yields a text block only', () => {
  const { tools } = harness()
  const tool = tools.get('desktop_see')
  assert.ok(tool)
  const blocks = tool.output.render({}, { text: 'failed' })
  assert.deepEqual(blocks.map(block => block.type), ['text'])
})

test('a worker configured without pointer input refuses the coordinate click', async () => {
  const { tools } = harness({ coordinateClick: false })
  const tool = tools.get('desktop_click_xy')
  assert.ok(tool)
  const value = await tool.execute({ x: 1, y: 1 }, exec())
  assert.match(String(value.text), /^COORDINATE_INPUT_OFF/)
})
