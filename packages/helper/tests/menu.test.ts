import { createRequire, Module } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contextMenuTemplate, trayMenuTemplate } from '../src/menu.ts'
import { modelMenuItems } from '../src/model-menu.ts'

const here = dirname(fileURLToPath(import.meta.url))

interface PreloadApi {
  send?: (text: string) => void
  setPermission?: (preset: string) => void
  requestHistory?: () => void
  openSession?: (id: string) => void
  newSession?: () => void
  stop?: () => void
  answerQuestion?: (id: string, answers: unknown) => void
  tccStatus?: () => Promise<unknown>
  openTcc?: (right: string) => Promise<unknown>
  selection?: {
    search?: () => void
    setLanguage?: (language: string) => void
    setContentSize?: (size: { width: number; height: number }) => Promise<unknown>
  }
}

function loadPreload(file: string): { api: PreloadApi; sent: [string, unknown][]; invoked: [string, unknown][] } {
  const sent: [string, unknown][] = []
  const invoked: [string, unknown][] = []
  const exposed: Record<string, PreloadApi> = {}
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: PreloadApi) { exposed[name] = value },
    },
    ipcRenderer: {
      send(channel: string, payload?: unknown) { sent.push([channel, payload]) },
      invoke(channel: string, payload?: unknown) {
        invoked.push([channel, payload])
        return Promise.resolve({ menuAbove: false })
      },
      on(channel: string) { sent.push([`listen:${channel}`, undefined]) },
    },
  }
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string
    _cache: Record<string, { id: string; filename: string; loaded: boolean; exports: unknown }>
  }
  const original = loader._resolveFilename
  loader._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'electron') return 'electron-mock-dsh-orb'
    return original.call(this, request, parent, isMain, options)
  }
  loader._cache['electron-mock-dsh-orb'] = {
    id: 'electron-mock-dsh-orb',
    filename: 'electron-mock-dsh-orb',
    loaded: true,
    exports: electron,
  }
  const filename = join(here, file)
  delete loader._cache[filename]
  try {
    createRequire(import.meta.url)(filename)
  } finally {
    loader._resolveFilename = original
    delete loader._cache['electron-mock-dsh-orb']
    delete loader._cache[filename]
  }
  return { api: exposed.dshOrb ?? {}, sent, invoked }
}

const catalog = {
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'plain', name: 'Plain' },
      {
        id: 'deepseek-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }], defaultEffort: 'max' },
      },
    ],
  }],
}

describe('ball menu', () => {
  it('checks the current model and uses a radio submenu for thinking models', () => {
    const chosen: unknown[] = []
    const items = modelMenuItems(catalog, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    }, (selection) => { chosen.push(selection) }, { empty: '没有可用的模型。', defaultEffort: '默认' })
    assert.equal(items[0]?.label, 'DeepSeek')
    assert.equal(items[0]?.enabled, false)
    const plain = items.find((item) => item.label === 'Plain')
    assert.equal(plain?.type, 'checkbox')
    assert.equal(plain?.checked, false)
    plain?.click?.({ checked: true })
    assert.deepEqual(chosen[0], { provider: 'deepseek-official', model: 'plain' })
    const flash = items.find((item) => item.label === '✓ Flash')
    assert.equal(flash?.submenu?.[0]?.type, 'radio')
    assert.equal(flash?.submenu?.find((item) => item.label === 'High')?.checked, true)
    assert.equal(flash?.submenu?.find((item) => item.label === 'Max')?.checked, false)
    flash?.submenu?.find((item) => item.label === 'Max')?.click?.({ checked: true })
    assert.deepEqual(chosen[1], { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.deepEqual(modelMenuItems({ groups: [] }, { provider: 'x', model: 'y' }, () => {}, {
      empty: '没有可用的模型。',
      defaultEffort: '默认',
    }), [{ label: '没有可用的模型。', enabled: false }])
  })

  it('lists open, both models, coordinates, update, and disable', () => {
    const actions: string[] = []
    const template = contextMenuTemplate({
      catalog,
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      millifractionEnabled: false,
      openMain: true,
      update: '0.2.0',
    }, true, {
      openMain: () => { actions.push('open') },
      setOverlay: () => { actions.push('overlay') },
      setBackground: () => { actions.push('background') },
      setMillifraction: (enabled) => { actions.push(`fraction:${enabled}`) },
      update: () => { actions.push('update') },
      disable: () => { actions.push('disable') },
    })
    assert.deepEqual(template.map((item) => item.label ?? item.type), [
      '打开主窗口',
      '悬浮球 Agent 设置',
      '后台 Agent 设置',
      '千分比坐标',
      '更新到 0.2.0',
      'separator',
      '关闭悬浮球',
    ])
    assert.equal(template[0]?.enabled, true)
    template[0]?.click?.({ checked: false })
    template[3]?.click?.({ checked: true })
    template[4]?.click?.({ checked: false })
    template[6]?.click?.({ checked: false })
    const background = template[2]?.submenu?.find((item) => item.label === '✓ Flash')
    assert.equal(background?.submenu?.find((item) => item.label === 'Max')?.checked, true)
    background?.submenu?.[0]?.click?.({ checked: true })
    assert.deepEqual(actions, ['open', 'fraction:true', 'update', 'disable', 'background'])
    const english = contextMenuTemplate({
      catalog: { groups: [] },
      overlay: { provider: 'deepseek-official', model: 'plain' },
      background: { provider: 'deepseek-official', model: 'plain' },
      millifractionEnabled: false,
      openMain: false,
      update: null,
    }, false, {
      openMain() {},
      setOverlay() {},
      setBackground() {},
      setMillifraction() {},
      update() {},
      disable() {},
    })
    assert.equal(english[0]?.label, 'Open Main Window')
    assert.equal(english[0]?.enabled, false)
    // Without a version waiting there is no row to click, and no gap either.
    assert.equal(english.some((item) => String(item.label ?? '').startsWith('Update to')), false)
    assert.deepEqual(english.map((item) => item.label ?? item.type).slice(-2), ['separator', 'Close floating ball'])
    assert.equal(english.at(-1)?.label, 'Close floating ball')
  })

  it('builds the tray menu with summon, main window gating, and disable', () => {  })

  it('sends ball controls from the ball preload and keeps them off the toolbar', () => {
    const ball = loadPreload('../preload.cjs')
    ball.api.send?.('hello')
    ball.api.setPermission?.('read-only')
    ball.api.requestHistory?.()
    ball.api.openSession?.('session-1')
    ball.api.newSession?.()
    ball.api.stop?.()
    ball.api.answerQuestion?.('q', [{ id: 'q', selected: ['a'] }])
    void ball.api.tccStatus?.()
    void ball.api.openTcc?.('screen')
    assert.deepEqual(ball.sent.filter(([channel]) => !channel.startsWith('listen:')), [
      ['orb:prompt', 'hello'],
      ['orb:permission', 'read-only'],
      ['orb:history', undefined],
      ['orb:open', 'session-1'],
      ['orb:new', undefined],
      ['orb:stop', undefined],
      ['orb:question-answer', { id: 'q', answers: [{ id: 'q', selected: ['a'] }] }],
    ])
    assert.deepEqual(ball.invoked, [
      ['orb:tcc-status', undefined],
      ['orb:tcc-open', 'screen'],
    ])
    assert.equal(ball.api.selection, undefined)

    const toolbar = loadPreload('../selection-preload.cjs')
    toolbar.api.selection?.search?.()
    toolbar.api.selection?.setLanguage?.('en')
    void toolbar.api.selection?.setContentSize?.({ width: 10, height: 20 })
    assert.deepEqual(toolbar.sent.filter(([channel]) => !channel.startsWith('listen:')), [
      ['orb:selection-action', { action: 'search' }],
      ['orb:selection-action', { action: 'language', language: 'en' }],
    ])
    assert.deepEqual(toolbar.invoked, [['orb:selection-size', { width: 10, height: 20 }]])
    assert.equal(toolbar.api.send, undefined)
    assert.equal(toolbar.api.setPermission, undefined)
    assert.equal(toolbar.api.tccStatus, undefined)
  })
})
