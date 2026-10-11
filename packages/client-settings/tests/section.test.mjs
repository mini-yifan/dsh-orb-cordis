import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')

// The host owns the preset ids, the page owns their names. Read the real list so a
// preset added on the host side without copy here fails a test instead of shipping.
const { AVATAR_PRESETS } = await import(pathToFileURL(join(root, 'packages/host/src/avatar-presets.ts')).href)

function loadSection() {
  const calls = []
  let mode = 'ready'
  let confirm = false
  let jump = null
  let workspace
  const intervals = []
  const snapshot = {
    supported: true,
    ballEnabled: true,
    helperError: '',
    helperPhase: '',
    avatarUrl: '/.dsh-orb/avatar?v=0',
    avatarPresetId: null,
    avatarPresets: AVATAR_PRESETS.map((preset) => ({ id: preset.id, url: `/.dsh-orb/avatar/preset/${preset.id}` })),
    overlay: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    selectionEnabled: false,
    millifractionEnabled: false,
    observationFrameEnabled: true,
    tcc: { applicable: true, appName: 'DeepSeek Harness', screen: 'missing', accessibility: 'granted' },
    update: {
      currentVersion: '0.1.0',
      installedVersion: '0.1.0',
      latestVersion: null,
      available: false,
      checking: false,
      updating: false,
      canUpdate: true,
      autoCheck: true,
      checkedAt: null,
      restartRequired: false,
      error: null,
      pendingBuilds: [],
    },
  }
  const catalog = {
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }], defaultEffort: 'max' },
      }, {
        id: 'deepseek-pro',
        name: 'Pro',
      }],
    }],
  }
  const stateSlots = []
  const effects = []
  const ran = new Set()
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child != null && child !== false && child !== true)
      if (typeof type === 'function') return type(props ?? {})
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const index = cursor++
      if (stateSlots[index] === undefined) stateSlots[index] = { current: initial }
      const slot = stateSlots[index]
      return [slot.current, (next) => {
        slot.current = typeof next === 'function' ? next(slot.current) : next
      }]
    },
    useEffect(effect) {
      effects[cursor] = effect
      cursor += 1
    },
  }
  let registered
  let plugin
  let file = { size: 10, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer } }
  const sandbox = {
    window: { confirm: () => confirm },
    document: {
      documentElement: { lang: '' },
      getElementById: () => null,
      head: { append() {} },
      createElement(tag) {
        if (tag !== 'input') return { id: '', textContent: '' }
        const input = {
          type: '',
          accept: '',
          files: [file],
          onchange: undefined,
          click() { input.onchange?.() },
        }
        return input
      },
    },
    navigator: { language: 'zh-CN' },
    fetch: async (path, options = {}) => {
      calls.push({ path, options })
      if (String(path).includes('token') || String(path).startsWith('http')) throw new Error(`credentialed fetch ${path}`)
      if (path === '/.dsh-orb/jump') {
        if (options.method === 'POST') return json({ ok: true })
        if (jump === null) return { ok: false, status: 404, async text() { return JSON.stringify({ error: 'missing' }) } }
        return json(jump)
      }
      if (path === '/.dsh-orb/settings') {
        return json(mode === 'linux' ? { ...snapshot, supported: false, tcc: { ...snapshot.tcc, applicable: false } } : snapshot)
      }
      if (path === '/.dsh-orb/models') return json(catalog)
      if (path === '/.dsh-orb/update') return json(snapshot.update)
      if (options.method === 'POST' && path === '/.dsh-orb/ball') snapshot.ballEnabled = JSON.parse(options.body).enabled
      if (options.method === 'POST' && path === '/.dsh-orb/millifraction') snapshot.millifractionEnabled = JSON.parse(options.body).enabled
      if (options.method === 'POST' && path === '/.dsh-orb/observation-frame') snapshot.observationFrameEnabled = JSON.parse(options.body).enabled
      if (options.method === 'POST' && path === '/.dsh-orb/overlay-model') snapshot.overlay = JSON.parse(options.body)
      if (options.method === 'POST' && path === '/.dsh-orb/avatar/preset') snapshot.avatarPresetId = JSON.parse(options.body).preset
      if (options.method === 'POST' && path === '/.dsh-orb/update/check') {
        snapshot.update = { ...snapshot.update, latestVersion: '0.2.0', available: true, checkedAt: 1700000000000 }
      }
      if (options.method === 'POST' && path === '/.dsh-orb/update/install') {
        const builds = JSON.parse(options.body).approvedBuilds
        snapshot.update = builds
          ? { ...snapshot.update, error: null, pendingBuilds: [], updating: true }
          : { ...snapshot.update, updating: true }
      }
      if (options.method === 'POST' && path === '/.dsh-orb/update/auto') snapshot.update = { ...snapshot.update, autoCheck: JSON.parse(options.body).enabled }
      if (options.method === 'POST') return json(snapshot)
      return { ok: false, status: 404, async text() { return JSON.stringify({ error: 'missing' }) } }
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    console,
  }
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      plugin = spec.factory((id) => {
        if (id === 'react') return React
        throw new Error(id)
      })
      return plugin
    },
  }
  runInContext(readFileSync(join(here, '../client.js'), 'utf8'), createContext(sandbox))
  const ctx = {
    slots: {
      inject(_name, register) { register() },
      register(spec, Component) { registered = { spec, Component } },
    },
    get(name) {
      return name === 'uiWorkspace' ? workspace : undefined
    },
    effect(run) { return run() },
  }
  plugin.apply(ctx)

  function render() {
    cursor = 0
    return registered.Component()
  }
  async function flush() {
    for (let index = 0; index < effects.length; index += 1) {
      if (effects[index] === undefined || ran.has(index)) continue
      ran.add(index)
      await effects[index]()
    }
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    calls,
    spec: registered.spec,
    snapshot,
    render,
    flush,
    /** Re-render the page, then run every registered interval once (timers persist). */
    async tick() {
      ran.clear()
      for (let index = 0; index < effects.length; index += 1) {
        if (effects[index] === undefined || ran.has(index)) continue
        ran.add(index)
        await effects[index]()
      }
      await settle()
      for (const interval of [...intervals]) await interval.fn()
      await settle()
      return intervals.length
    },
    setMode(next) { mode = next },
    setConfirm(next) { confirm = next },
    /** Arm (or clear) the ball-initiated jump target the bridge polls for. */
    setJump(next) { jump = next },
    /** Provide (or remove) the workspace navigator the bridge opens sessions through. */
    setWorkspace(next) { workspace = next },
    setFile(next) { file = next },
    setLang(next) { sandbox.document.documentElement.lang = next },
    /** Replace the whole update block, or drop it as a host without a version would. */
    setUpdate(next) { snapshot.update = next === null ? undefined : { ...snapshot.update, ...next } },
    reset() {
      stateSlots.length = 0
      effects.length = 0
      ran.clear()
    },
  }
}

function json(body) {
  return { ok: true, status: 200, async text() { return JSON.stringify(body) } }
}

function find(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) find(child, predicate, found)
  return found
}

describe('settings section', () => {
  it('registers 悬浮球 and talks to /.dsh-orb with relative fetches', async () => {
    const page = loadSection()
    assert.equal(page.spec.id, 'orb')
    assert.equal(page.spec.order, 25)
    assert.equal(page.spec.name, 'settings.section')
    assert.equal(page.spec.label(), '悬浮球')
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.deepEqual(page.calls.map((call) => call.path), ['/.dsh-orb/settings', '/.dsh-orb/models'])
    const avatar = find(view, (node) => node.type === 'img')[0]
    assert.equal(avatar.props.src, '/.dsh-orb/avatar?v=0')
    assert.equal(String(avatar.props.src).includes('token'), false)

    const ball = find(view, (node) => node.props?.['aria-label'] === '启用悬浮球')[0]
    ball.props.onClick()
    await settle()
    const ballCall = page.calls.at(-1)
    assert.equal(ballCall.path, '/.dsh-orb/ball')
    assert.equal(JSON.parse(ballCall.options.body).enabled, false)

    view = page.render()
    const fraction = find(view, (node) => node.props?.['aria-label'] === '使用千分比坐标')[0]
    page.setConfirm(false)
    fraction.props.onClick()
    await settle()
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/millifraction'), false)
    page.setConfirm(true)
    fraction.props.onClick()
    await settle()
    const fractionCall = page.calls.find((call) => call.path === '/.dsh-orb/millifraction')
    assert.equal(JSON.parse(fractionCall.options.body).enabled, true)

    view = page.render()
    const frame = find(view, (node) => node.props?.['aria-label'] === '显示观察框彩带')[0]
    frame.props.onClick()
    await settle()
    const frameCall = page.calls.find((call) => call.path === '/.dsh-orb/observation-frame')
    assert.equal(JSON.parse(frameCall.options.body).enabled, false)

    view = page.render()
    const overlay = find(view, (node) => node.type === 'select' && node.props['aria-label'] === '悬浮球 Agent')[0]
    overlay.props.onChange({ target: { value: 'deepseek-official\u001fdeepseek-pro' } })
    await settle()
    const modelCall = page.calls.find((call) => call.path === '/.dsh-orb/overlay-model')
    assert.deepEqual(JSON.parse(modelCall.options.body), { provider: 'deepseek-official', model: 'deepseek-pro' })

    const choose = find(view, (node) => node.type === 'button' && node.children?.includes('选择图片'))[0]
    page.setFile({ size: 3 * 1024 * 1024, async arrayBuffer() { throw new Error('unread') } })
    choose.props.onClick()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('图片超过 2 MB。')).length, 1)
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/avatar'), false)

    // Built-in GIFs: one animated thumbnail per shipped preset, named, and pickable.
    const gallery = find(view, (node) => node.props?.className === 'dsh-orb-set-presets-row')[0]
    assert.ok(gallery)
    const thumbs = gallery.children
    assert.equal(thumbs.length, AVATAR_PRESETS.length)
    for (const [index, preset] of AVATAR_PRESETS.entries()) {
      const button = thumbs[index]
      const image = find(button, (node) => node.type === 'img')[0]
      assert.equal(image.props.src, `/.dsh-orb/avatar/preset/${preset.id}`)
      const name = button.children.find((child) => child.type === 'span')
      assert.ok(name.children[0].length > 0, `${preset.id} has copy`)
      assert.equal(name.children[0] === preset.id, false, `${preset.id} has a real label, not the raw id`)
      assert.equal(button.props['aria-pressed'], 'false')
    }
    thumbs[1].props.onClick()
    await settle()
    const pick = page.calls.find((call) => call.path === '/.dsh-orb/avatar/preset')
    assert.equal(JSON.parse(pick.options.body).preset, AVATAR_PRESETS[1].id)

    // The snapshot the host echoes back is what marks the pick.
    view = page.render()
    const selected = find(view, (node) => node.props?.className === 'dsh-orb-set-preset is-selected')
    assert.equal(selected.length, 1)
    assert.equal(selected[0].props['aria-pressed'], 'true')

    page.setMode('linux')
    page.reset()
    page.calls.length = 0
    view = page.render()
    await page.flush()
    view = page.render()
    const fieldset = find(view, (node) => node.type === 'fieldset')[0]
    assert.equal(fieldset.props.disabled, true)
    assert.equal(find(view, (node) => node.children?.includes('悬浮球在 Linux 上不可用。')).length, 1)

    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'))
    assert.equal(pkg.name, '@dsh-orb/client-ui-settings-orb')
    assert.equal(pkg.exports['./client'], './client.js')
    assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
    const patch = readFileSync(join(root, 'packages/bundle/cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: ui-settings-orb/)
    // \r? so a Windows checkout of the patch (CRLF) matches the same way.
    assert.match(patch, /id: ui-settings-orb\r?\n\s+name: dsh-orb\r?\n/)
    const client = readFileSync(join(here, '../client.js'), 'utf8')
    // The selection toolbar is disabled (buggy): no settings entry point may ship.
    assert.equal(client.includes('划词'), false)
    assert.equal(client.includes('selectionToggle'), false)
    assert.equal(client.includes('authenticatedUrl'), false)
  })

  it('explains the first-launch runtime wait and offers a retry when it failed', async () => {
    const page = loadSection()
    page.snapshot.helperPhase = 'downloading'
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(
      find(view, (node) => node.children?.includes('正在准备悬浮球：首次使用需要下载约 124–150 MB 的运行时，完成后悬浮球会自动出现。')).length,
      1,
      'the waiting line tells the user the ball is being prepared',
    )

    page.snapshot.helperPhase = ''
    page.snapshot.helperError = 'runtime-download'
    await page.tick()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('悬浮球运行时没有下载成功。关闭后再打开可再试一次。')).length, 1)
    const retry = find(view, (node) => node.type === 'button' && node.children?.includes('重试'))[0]
    assert.ok(retry, 'the failure line carries a retry button')
    retry.props.onClick()
    await settle()
    const call = page.calls.at(-1)
    assert.equal(call.path, '/.dsh-orb/ball')
    assert.equal(JSON.parse(call.options.body).enabled, true, 'retry asks the host to start the ball again')

    page.snapshot.helperError = ''
  })

  it('follows the main window locale on <html lang>', () => {
    const page = loadSection()
    assert.equal(page.spec.label(), '悬浮球', 'zh-CN navigator with no lang stays Chinese')
    page.setLang('en')
    assert.equal(page.spec.label(), 'Floating ball')
    page.setLang('zh-CN')
    assert.equal(page.spec.label(), '悬浮球')
    page.setLang('')
    assert.equal(page.spec.label(), '悬浮球', 'no lang falls back to the browser languages')
  })

  it('opens the armed jump target once and confirms it without re-opening', async () => {
    const page = loadSection()
    const opened = []
    page.setWorkspace({ openSession(id) { opened.push(id) } })
    page.setJump({ sessionId: 'session-agent-9', at: 7 })
    await page.tick()
    assert.deepEqual(opened, ['session-agent-9'])
    const posts = () => page.calls.filter((call) => call.path === '/.dsh-orb/jump' && call.options.method === 'POST')
    assert.equal(posts().length, 1, 'the confirmed target is consumed with a POST')
    assert.deepEqual(JSON.parse(posts()[0].options.body), { sessionId: 'session-agent-9' })

    // The same armed target read again (confirm lost) must re-confirm only:
    // re-opening would yank the main view back on every poll.
    page.setJump({ sessionId: 'session-agent-9', at: 7 })
    await page.tick()
    assert.deepEqual(opened, ['session-agent-9'])
    assert.equal(posts().length, 2)

    // A re-armed target (new timestamp) is a fresh click and opens again.
    page.setJump({ sessionId: 'session-agent-9', at: 99 })
    await page.tick()
    assert.deepEqual(opened, ['session-agent-9', 'session-agent-9'])
    assert.equal(posts().length, 3)
  })

  it('offers the new version and installs it without leaving the page', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()
    const text = (node) => (node.children ?? []).filter((child) => typeof child === 'string').join('')
    const texts = () => find(view, (node) => typeof node.type === 'string').map(text).join(' ')
    assert.match(texts(), /当前版本 0\.1\.0。/)
    assert.ok(find(view, (node) => node.props?.['aria-label'] === '自动检查更新')[0], 'the automatic check is switchable')
    assert.equal(find(view, (node) => node.type === 'button' && text(node) === '更新').length, 0, 'no update is offered before one is known')

    // The check finds a newer version: the card turns into a banner plus a button.
    const check = find(view, (node) => node.type === 'button' && text(node) === '检查更新')[0]
    assert.ok(check, 'a manual check is always available')
    check.props.onClick()
    await settle()
    view = page.render()
    assert.equal(page.calls.at(-1).path, '/.dsh-orb/update/check')
    assert.match(texts(), /新版本 0\.2\.0 可用。/)
    const install = find(view, (node) => node.type === 'button' && text(node) === '更新')[0]
    assert.ok(install)

    // Installing POSTs and then polls until the host reports the new state.
    install.props.onClick()
    await settle()
    const installCall = page.calls.at(-1)
    assert.equal(installCall.path, '/.dsh-orb/update/install')
    assert.deepEqual(JSON.parse(installCall.options.body), {})
    view = page.render()
    assert.match(texts(), /正在更新到 0\.2\.0…/)
    const before = page.calls.length
    // The settings poll runs alongside the bookmark jump bridge's poll, so the
    // interval count is only "at least the install poll".
    assert.ok(await page.tick() >= 1, 'the page polls while the install runs')
    assert.equal(page.calls.slice(before).some((call) => call.path === '/.dsh-orb/update'), true)

    // A blocked install offers the approval retry with the pending package names.
    page.setUpdate({ updating: false, available: true, error: 'build-blocked', pendingBuilds: ['koffi'] })
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.match(texts(), /更新失败：新版本依赖的安装脚本未获授权/)
    const allow = find(view, (node) => node.type === 'button' && text(node) === '允许安装脚本并重试')[0]
    assert.ok(allow)
    allow.props.onClick()
    await settle()
    assert.deepEqual(JSON.parse(page.calls.at(-1).options.body), { approvedBuilds: ['koffi'] })

    // Once installed, the card asks for the restart instead of offering the same version again.
    page.setUpdate({ updating: false, available: false, error: null, restartRequired: true, installedVersion: '0.2.0', latestVersion: '0.2.0' })
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.match(texts(), /已更新到 0\.2\.0，重启 DeepSeek Harness 后生效。/)
    assert.equal(find(view, (node) => node.type === 'button' && text(node) === '更新').length, 0)

    const toggle = find(view, (node) => node.props?.['aria-label'] === '自动检查更新')[0]
    toggle.props.onClick()
    await settle()
    assert.deepEqual(JSON.parse(page.calls.at(-1).options.body), { enabled: false })
    assert.equal(page.calls.at(-1).path, '/.dsh-orb/update/auto')
  })

  it('leaves the update card out where the host has no version to report', async () => {
    const page = loadSection()
    page.setUpdate(null)
    let view = page.render()
    await page.flush()
    view = page.render()
    const texts = find(view, (node) => typeof node.type === 'string').map((node) => (node.children ?? []).filter((child) => typeof child === 'string').join('')).join(' ')
    assert.equal(texts.includes('插件更新'), false)
    assert.equal(texts.includes('检查更新'), false)
  })
})

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
