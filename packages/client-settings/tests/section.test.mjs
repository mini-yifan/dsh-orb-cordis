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
const { qwenVoiceViews } = await import(pathToFileURL(join(root, 'packages/voice/src/qwen.ts')).href)
const { WHATS_NEW_VERSION } = await import(pathToFileURL(join(root, 'packages/host/src/whats-new.ts')).href)

function loadSection(hooks = {}) {
  const calls = []
  const styles = []
  let mode = 'ready'
  let confirm = false
  let previewRoots = 2
  let jump = null
  /** Armed floating-ball-settings target, as `/.dsh-orb/settings-open` reports it. */
  let settingsOpen = null
  /** The `sidebar.settings` ledger, where a mounted settings shell leaves its store handle. */
  const shellEntries = []
  /** This page's own `settings.section` row, as the shell shell's ledger holds it. */
  const sectionEntries = []
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
    qwenVoices: qwenVoiceViews(),
    overlay: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    background: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    selectionEnabled: true,
    millifractionEnabled: false,
    observationFrameEnabled: true,
    voice: { voiceEnabled: true },
    tcc: { applicable: true, appName: 'DeepSeek Harness', screen: 'missing', accessibility: 'granted' },
    workspace: {
      path: '/Users/test/.dsh/dsh_orb',
      defaultPath: '/Users/test/.dsh/dsh_orb',
      custom: false,
    },
    history: {
      available: true,
      workspacePath: '/Users/test/.dsh/dsh_orb',
      retentionDays: 0,
      cleaning: false,
      phase: '',
      error: null,
      lastCleanupAt: null,
      lastDeletedSessions: 0,
      lastMovedBytes: 0,
      warning: '',
      warningSessions: 0,
    },
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
      installing: false,
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
    /** Same slot bookkeeping as useState, without a setter: the box survives every render. */
    useRef(initial) {
      const index = cursor++
      if (stateSlots[index] === undefined) stateSlots[index] = { current: initial }
      return stateSlots[index]
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
    AbortController,
    window: { confirm: () => confirm },
    document: {
      documentElement: { lang: '' },
      getElementById: (id) => styles.find((node) => node.id === id) ?? null,
      head: { append(node) { styles.push(node) } },
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
      // A test can answer one request itself, e.g. to let a stale response arrive late.
      const custom = hooks.answer?.(path, options, snapshot)
      if (custom !== undefined) return custom
      if (String(path).includes('token') || String(path).startsWith('http')) throw new Error(`credentialed fetch ${path}`)
      if (path === '/.dsh-orb/jump') {
        if (options.method === 'POST') return json({ ok: true })
        if (jump === null) return { ok: false, status: 404, async text() { return JSON.stringify({ error: 'missing' }) } }
        return json(jump)
      }
      if (path === '/.dsh-orb/settings-open') {
        if (options.method === 'POST') {
          if (settingsOpen !== null && settingsOpen.at === JSON.parse(options.body).at) settingsOpen = null
          return json({ ok: true })
        }
        return json({ at: settingsOpen === null ? null : settingsOpen.at })
      }
      if (path === '/.dsh-orb/settings') {
        return json(mode === 'linux' ? { ...snapshot, supported: false, tcc: { ...snapshot.tcc, applicable: false } } : snapshot)
      }
      if (path === '/.dsh-orb/models') return json(catalog)
      if (path === '/.dsh-orb/update') return json(snapshot.update)
      if (path === '/.dsh-orb/history') return json(snapshot.history)
      if (options.method === 'POST' && path === '/.dsh-orb/history/preview') {
        const days = JSON.parse(options.body).days
        const sessions = [{ id: 'session-a', title: '会话 A', updatedAt: 1 }, { id: 'session-b', title: '会话 B', updatedAt: 2 }].slice(0, previewRoots)
        return json({ preview: { days, cutoff: 0, roots: previewRoots, members: previewRoots, images: previewRoots, bytes: previewRoots * 1024 * 1024, oldest: null, newest: null, skipped: { active: 0, pinned: 0, archived: 0, current: 0, unchanged: 0, unreadable: 0, restored: 0 }, sessions } })
      }
      if (options.method === 'POST' && path === '/.dsh-orb/history/retention') {
        snapshot.history = { ...snapshot.history, retentionDays: JSON.parse(options.body).days }
      }
      if (options.method === 'POST' && path === '/.dsh-orb/workspace/pick') {
        return json({ path: '/tmp/picked-workspace' })
      }
      if (options.method === 'POST' && path === '/.dsh-orb/workspace') {
        const next = JSON.parse(options.body).path
        if (next === '/not-empty') return { ok: false, status: 400, async text() { return JSON.stringify({ error: 'workspace-not-empty' }) } }
        if (next === '/running') return { ok: false, status: 409, async text() { return JSON.stringify({ error: 'workspace-running' }) } }
        snapshot.workspace = { ...snapshot.workspace, path: next, custom: next !== snapshot.workspace.defaultPath }
        return json(snapshot)
      }
      if (options.method === 'POST' && path === '/.dsh-orb/history/clean') {
        snapshot.history = { ...snapshot.history, cleaning: false, lastCleanupAt: 1700000000000 }
      }
      if (options.method === 'POST' && path === '/.dsh-orb/ball') snapshot.ballEnabled = JSON.parse(options.body).enabled
      if (options.method === 'POST' && path === '/.dsh-orb/runtime/redownload') {
        // The host drops the failure and arms a fresh attempt, exactly like a first launch.
        snapshot.helperError = ''
        snapshot.helperPhase = 'downloading'
      }
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
      if (options.method === 'POST' && path === '/.dsh-orb/whats-new/dismiss') {
        const id = JSON.parse(options.body).id
        if (snapshot.whatsNew && snapshot.whatsNew.id === id) snapshot.whatsNew = null
        return json(snapshot)
      }
      if (options.method === 'POST' && path === '/.dsh-orb/voice') snapshot.voice = JSON.parse(options.body)
      if (options.method === 'POST' && path === '/.dsh-orb/voice/download') {
        const kind = JSON.parse(options.body).kind
        const model = snapshot.voiceModels && snapshot.voiceModels[kind]
        if (model && model.downloading) return json(snapshot)
        if (model && model.present) {
          snapshot.voiceModels = { ...snapshot.voiceModels, [kind]: { ...model, notice: 'present' } }
          return json(snapshot)
        }
      }
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
      register(spec, Component) {
        registered = { spec, Component }
        sectionEntries.length = 0
        sectionEntries.push({ options: { id: spec.id } })
      },
      entries(name) {
        if (name === 'sidebar.settings') return shellEntries
        if (name === 'settings.section') return sectionEntries
        return []
      },
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
    styles,
    /** A hot reload applies the plugin again over the same document. */
    reapply() { plugin.apply(ctx) },
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
    /**
     * Mount (or remove) a stand-in for the settings shell's `sidebar.settings` entry.
     * The shape mirrors SlotCore's register(): the store handle is a field of the entry
     * itself, while `options` carries only id/order/label/priority.
     */
    setShell(next) {
      shellEntries.length = 0
      if (next !== undefined) shellEntries.push({ component: null, options: {}, store: next })
    },
    /** Take this page's own `settings.section` row off the ledger (as a reload would). */
    dropSection() { sectionEntries.length = 0 },
    /** Arm (or clear) the settings target the ball's menu row leaves behind. */
    setSettingsOpen(next) { settingsOpen = next },
    /** Provide (or remove) the workspace navigator the bridge opens sessions through. */
    setWorkspace(next) { workspace = next },
    setFile(next) { file = next },
    setLang(next) { sandbox.document.documentElement.lang = next },
    /** Replace the whole update block, or drop it as a host without a version would. */
    setUpdate(next) { snapshot.update = next === null ? undefined : { ...snapshot.update, ...next } },
    /** Replace the whole history block. */
    setHistory(next) { snapshot.history = next },
    /** How many old conversations the next preview reports. */
    setPreviewRoots(next) { previewRoots = next },
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
    // Over the cap: the message names the file's own size, so nobody has to guess whether
    // the file or the plugin was at fault.
    page.setFile({ size: 5 * 1024 * 1024 + 300 * 1024, async arrayBuffer() { throw new Error('unread') } })
    choose.props.onClick()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('图片 5.3 MB，超过 4 MB 上限。')).length, 1)
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/avatar'), false)
    // Under the cap but unreadable: the upload must say so rather than do nothing at all.
    page.setFile({ size: 1024, async arrayBuffer() { throw new Error('unread') } })
    choose.props.onClick()
    await settle()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('读不到这个文件，请重新选择一次。')).length, 1)
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/avatar'), false)
    // The copy states the same limit the check enforces.
    assert.equal(find(view, (node) => node.children?.includes('点一张内置动图，或选择自己的图片。上传支持 GIF、PNG、WebP，4 MB 以内。')).length, 1)

    // Built-in GIFs: one animated thumbnail per shipped preset, named, and pickable.
    const gallery = find(view, (node) => node.props?.className === 'dsh-orb-set-presets-row')[0]
    assert.ok(gallery)
    const thumbs = gallery.children
    // The built-ins, plus the trailing text link into the community GIF gallery.
    assert.equal(thumbs.length, AVATAR_PRESETS.length + 1)
    for (const [index, preset] of AVATAR_PRESETS.entries()) {
      const button = thumbs[index]
      const image = find(button, (node) => node.type === 'img')[0]
      assert.equal(image.props.src, `/.dsh-orb/avatar/preset/${preset.id}`)
      const name = button.children.find((child) => child.type === 'span')
      assert.ok(name.children[0].length > 0, `${preset.id} has copy`)
      assert.equal(name.children[0] === preset.id, false, `${preset.id} has a real label, not the raw id`)
      assert.equal(button.props['aria-pressed'], 'false')
    }
    // "More animations" is a text link in the row's leftover space, not a seventh tile: it
    // must not borrow the preset styling, and it is a plain outbound link — the shell turns
    // a window open into the system browser, so it carries the gallery URL and never a
    // fetch of our own.
    const more = thumbs.at(-1)
    assert.equal(more.type, 'a')
    assert.equal(more.props.className, 'dsh-orb-set-more')
    assert.equal(more.props.href, 'https://dshgif.hicp.fun/')
    assert.equal(more.props.target, '_blank')
    assert.equal(more.props.rel, 'noopener noreferrer')
    assert.ok(more.props.title.length > 0, 'the tooltip names the gallery')
    assert.deepEqual(more.children, ['更多动图'], 'the label alone, sized to fit the leftover space')
    assert.equal(page.calls.some((call) => String(call.path).includes('dshgif')), false)
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
    // The selection toolbar ships with an entry point in both directions: its card and the
    // unavailable banner that explains a monitor which never loaded.
    assert.match(client, /selectionToggle/)
    assert.match(client, /\/\.dsh-orb\/selection/)
    assert.match(client, /selectionUnavailable/)
    assert.equal(client.includes('authenticatedUrl'), false)
  })

  it('offers the GIF gallery on every host, under the interface language', async () => {
    const page = loadSection()
    page.render()
    await page.flush()
    // An older host sends no built-in list at all. The gallery link is this page's own, so it
    // must survive that — without leaving a stray "内置动图" heading over an empty row.
    page.snapshot.avatarPresets = []
    await page.tick()
    let view = page.render()
    assert.equal(find(view, (node) => node.props?.className === 'dsh-orb-set-presets-title').length, 0)
    const row = find(view, (node) => node.props?.className === 'dsh-orb-set-presets-row')[0]
    assert.ok(row, 'the gallery link does not depend on the host preset list')
    assert.equal(row.props['aria-label'], '更多动图')
    assert.equal(row.props['aria-labelledby'], undefined)
    assert.equal(row.children.length, 1)
    const link = row.children[0]
    assert.equal(link.type, 'a')
    assert.equal(link.props.className, 'dsh-orb-set-more is-alone', 'nothing to trail, so it sits flush left')
    assert.equal(link.props.href, 'https://dshgif.hicp.fun/')
    assert.equal(link.props.target, '_blank')

    // The link's copy follows <html lang> like the rest of the page; the URL never does.
    page.setLang('en')
    view = page.render()
    const translated = find(view, (node) => node.type === 'a' && node.props?.href === 'https://dshgif.hicp.fun/')[0]
    assert.deepEqual(translated.children, ['More animations'])
    page.setLang('')
  })

  it('rewrites its stylesheet when the plugin is applied again', () => {
    const page = loadSection()
    assert.equal(page.styles.length, 1, 'one stylesheet per document')
    const node = page.styles[0]
    assert.equal(node.id, 'dsh-orb-settings-style')
    assert.match(node.textContent, /\.dsh-orb-set-more \{/, 'the gallery link is styled')
    // A hot reload keeps the previous run's <style> in the document. Skipping the write
    // because the node exists would leave old rules on markup that already expects new ones
    // (a wrapped, underlined plain <a> in place of the link), which is exactly what shipped.
    node.textContent = 'stale rules'
    page.reapply()
    assert.equal(page.styles.length, 1, 'no second stylesheet node')
    assert.match(node.textContent, /\.dsh-orb-set-more \{/, 'the live node is rewritten, not left stale')
  })

  it('shows the runtime wait and its failure as loud notices whose button downloads again', async () => {
    const page = loadSection()
    const notice = (view, tone) => find(view, (node) => node.props?.className === `dsh-orb-set-notice is-${tone}`)[0]
    const said = (node) => {
      if (typeof node === 'string') return node
      if (!node || typeof node !== 'object') return ''
      return (node.children ?? []).map(said).join('')
    }
    const actionOf = (node) => find(node, (child) => child.type === 'button' && String(child.props?.className).includes('dsh-orb-set-notice-action'))[0]

    page.snapshot.helperPhase = 'downloading'
    let view = page.render()
    await page.flush()
    view = page.render()
    const waiting = notice(view, 'wait')
    assert.ok(waiting, 'the wait is a notice block, not a bare grey line')
    assert.match(said(waiting), /正在下载悬浮球运行时/)
    assert.match(said(waiting), /124–150 MB/)
    const waitAction = actionOf(waiting)
    assert.ok(waitAction, 'the wait carries its own action, so an interrupted download can be restarted')
    assert.equal(waitAction.children[0], '重新下载')
    waitAction.props.onClick()
    await settle()
    assert.equal(page.calls.at(-1).path, '/.dsh-orb/runtime/redownload', 'the wait action downloads again')

    page.snapshot.helperPhase = ''
    page.snapshot.helperError = 'runtime-download'
    await page.tick()
    view = page.render()
    const failed = notice(view, 'error')
    assert.ok(failed, 'the failure is a notice block')
    assert.match(said(failed), /悬浮球运行时下载失败/)
    assert.match(said(failed), /不用重启应用/)
    const action = actionOf(failed)
    assert.ok(action, 'the failure carries a download button')
    assert.equal(action.children[0], '重新下载')
    // The old block hung a ghost button under the sentence; the loud one is a primary button.
    assert.doesNotMatch(String(action.props.className), /ghost/)
    action.props.onClick()
    await settle()
    assert.equal(page.calls.at(-1).path, '/.dsh-orb/runtime/redownload')
    assert.equal(JSON.parse(page.calls.at(-1).options.body).enabled, undefined, 'a redownload is not a ball toggle')

    page.snapshot.helperError = 'helper-exited'
    await page.tick()
    view = page.render()
    const exited = notice(view, 'error')
    assert.match(said(exited), /悬浮球没能启动/)
    const retry = actionOf(exited)
    assert.equal(retry.children[0], '重试')
    retry.props.onClick()
    await settle()
    assert.equal(page.calls.at(-1).path, '/.dsh-orb/ball')
    assert.equal(JSON.parse(page.calls.at(-1).options.body).enabled, true, 'retry asks the host to start the ball again')

    page.snapshot.helperError = ''
  })

  it('shows the 0.2.0 release note once, with two ways to close it', async () => {
    const note = { id: WHATS_NEW_VERSION, version: WHATS_NEW_VERSION }
    const cardOf = (view) => find(view, (node) => String(node.props?.className).includes('dsh-orb-set-whats-new'))[0]
    const said = (node) => {
      if (typeof node === 'string') return node
      if (!node || typeof node !== 'object') return ''
      return (node.children ?? []).map(said).join('')
    }
    const loaded = async (page) => {
      page.snapshot.whatsNew = note
      page.render()
      await page.flush()
      return page.render()
    }

    const page = loadSection()
    let view = await loaded(page)
    const card = cardOf(view)
    assert.ok(card, 'the first open of the settings page shows the note')
    assert.equal(card.props.role, 'region')
    assert.equal(card.props['aria-labelledby'], 'dsh-orb-set-whats-new-title')
    assert.match(said(card), /悬浮球 0\.2\.0 更新/)
    assert.match(said(card), /Windows 首次安装修复/)
    assert.match(said(card), /语音唤醒与输入/)
    assert.match(said(card), /语音播报与插话/)
    assert.match(said(card), /语音模型下载/)
    const known = find(card, (node) => node.type === 'button' && String(node.props?.className).includes('dsh-orb-set-whats-new-known'))[0]
    assert.equal(known.children[0], '知道了')
    known.props.onClick()
    await settle()
    assert.equal(page.calls.at(-1).path, '/.dsh-orb/whats-new/dismiss')
    assert.deepEqual(JSON.parse(page.calls.at(-1).options.body), { id: WHATS_NEW_VERSION })
    assert.equal(cardOf(page.render()), undefined, 'the card disappears as soon as the host confirms')

    // The corner × is the other way to dismiss; it uses the same route and id.
    const corner = loadSection()
    view = await loaded(corner)
    const close = find(view, (node) => node.type === 'button' && node.props?.['aria-label'] === '关闭更新公告')[0]
    assert.ok(close, 'the corner × is labelled for screen readers')
    close.props.onClick()
    await settle()
    assert.equal(corner.calls.at(-1).path, '/.dsh-orb/whats-new/dismiss')
    assert.deepEqual(JSON.parse(corner.calls.at(-1).options.body), { id: WHATS_NEW_VERSION })
    assert.equal(cardOf(corner.render()), undefined)

    // Copy follows <html lang>; the note id must stay the same.
    const english = loadSection()
    english.setLang('en')
    view = await loaded(english)
    const englishCard = cardOf(view)
    assert.match(said(englishCard), /Floating ball 0\.2\.0 update/)
    assert.match(said(englishCard), /Got it/)

    // Linux, a mismatched client copy, and an absent field all stay dark.
    const linux = loadSection()
    linux.setMode('linux')
    view = await loaded(linux)
    assert.equal(cardOf(view), undefined, 'Linux never shows the note')

    const mismatched = loadSection()
    mismatched.snapshot.whatsNew = { id: '0.1.9', version: '0.1.9' }
    mismatched.render()
    await mismatched.flush()
    assert.equal(cardOf(mismatched.render()), undefined, 'client copy and host id must agree')

    assert.match(page.styles[0].textContent, /\.dsh-orb-set-notice\.is-info/)
    assert.match(page.styles[0].textContent, /\.dsh-orb-set-whats-new-close/)
    assert.match(page.styles[0].textContent, /\.dsh-orb-set-whats-new-list/)
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

  it('opens the floating-ball section when the ball asks for it', async () => {
    const page = loadSection()
    const opened = []
    const instance = { actions: { openSection(id) { opened.push(id) } } }
    const handle = { create: () => instance }
    const posts = () => page.calls.filter((call) => call.path === '/.dsh-orb/settings-open' && call.options.method === 'POST')

    // The ball was clicked while this window was still composing its plugins: the
    // target must survive, and nothing may be confirmed before the panel really opens.
    page.setSettingsOpen({ at: 11 })
    await page.tick()
    assert.deepEqual(opened, [])
    assert.equal(posts().length, 0)

    page.setShell(handle)
    await page.tick()
    assert.deepEqual(opened, ['orb'])
    assert.equal(posts().length, 1, 'the opened target is consumed with a POST')
    assert.deepEqual(JSON.parse(posts()[0].options.body), { at: 11 })

    // A lost confirm re-confirms on the next poll; the panel must not be re-opened.
    page.setSettingsOpen({ at: 11 })
    await page.tick()
    assert.deepEqual(opened, ['orb'])
    assert.equal(posts().length, 2)

    // A fresh click carries a new arm timestamp and switches the panel again.
    page.setSettingsOpen({ at: 12 })
    await page.tick()
    assert.deepEqual(opened, ['orb', 'orb'])
    assert.equal(posts().length, 3)

    // A bare store handle (create() mints a fresh store) is not a mounted shell: the
    // click stays armed rather than reporting an open nobody can see.
    page.setShell({ create: () => ({ actions: { openSection(id) { opened.push(id) } } }) })
    page.setSettingsOpen({ at: 13 })
    await page.tick()
    assert.deepEqual(opened, ['orb', 'orb'])
    assert.equal(posts().length, 3)

    // Without this page's own row on the section ledger there is nothing to show:
    // opening anyway would leave an empty panel, so the click stays armed.
    page.setShell(handle)
    page.dropSection()
    page.setSettingsOpen({ at: 14 })
    await page.tick()
    assert.deepEqual(opened, ['orb', 'orb'])
    assert.equal(posts().length, 3)
    page.setSettingsOpen(null)
  })

  it('changes the Agent workspace only after an explicit confirmation', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.type === 'h3' && node.children?.[0] === 'Agent 工作区').length, 1)
    assert.equal(find(view, (node) => node.children?.includes('当前工作区：/Users/test/.dsh/dsh_orb（默认）')).length, 1)
    const defaultButton = find(view, (node) => node.type === 'button' && node.children?.includes('恢复默认工作区'))[0]
    assert.equal(defaultButton.props.disabled, true)
    assert.equal(find(view, (node) => node.type === 'button' && node.children?.includes('修改')).length, 0)
    const pathButton = find(view, (node) => node.type === 'button' && node.props?.className === 'dsh-orb-set-path')[0]
    assert.equal(pathButton.children?.[0], '/Users/test/.dsh/dsh_orb')
    pathButton.props.onClick()
    await settle()
    view = page.render()
    let dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.ok(dialog)
    assert.equal(find(dialog, (node) => node.children?.includes('工作区将从 /Users/test/.dsh/dsh_orb 改为 /tmp/picked-workspace。')).length, 1)
    assert.equal(find(dialog, (node) => node.children?.includes('旧工作区中的会话和文件会保持不变，不会被移动或删除。')).length, 1)
    assert.ok(!page.calls.some((call) => call.path === '/.dsh-orb/workspace'))
    const cancel = find(dialog, (node) => node.type === 'button' && node.children?.includes('取消'))[0]
    cancel.props.onClick()
    await settle()
    assert.ok(!page.calls.some((call) => call.path === '/.dsh-orb/workspace'))
    assert.equal(page.snapshot.workspace.path, '/Users/test/.dsh/dsh_orb')

    view = page.render()
    const pick = find(view, (node) => node.type === 'button' && node.props?.['aria-label'] === '选择…')[0]
    pick.props.onClick()
    await settle()
    view = page.render()
    dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    const confirm = find(dialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0]
    confirm.props.onClick()
    await settle()
    assert.equal(page.snapshot.workspace.path, '/tmp/picked-workspace')
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('当前工作区：/tmp/picked-workspace（自定义）')).length, 1)
    assert.equal(find(view, (node) => node.type === 'button' && node.props?.className === 'dsh-orb-set-path')[0].children?.[0], '/tmp/picked-workspace')
    assert.equal(find(view, (node) => node.children?.includes('工作区已切换。')).length, 1)
    let restore = find(view, (node) => node.type === 'button' && node.children?.includes('恢复默认工作区'))[0]
    assert.equal(restore.props.disabled, false)

    view = page.render()
    restore = find(view, (node) => node.type === 'button' && node.children?.includes('恢复默认工作区'))[0]
    restore.props.onClick()
    view = page.render()
    dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.ok(dialog)
    assert.equal(find(dialog, (node) => node.children?.includes('工作区将从 /tmp/picked-workspace 改为 /Users/test/.dsh/dsh_orb。')).length, 1)
    const confirmRestore = find(dialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0]
    confirmRestore.props.onClick()
    await settle()
    view = page.render()
    assert.equal(page.snapshot.workspace.path, '/Users/test/.dsh/dsh_orb')
    assert.equal(find(view, (node) => node.children?.includes('当前工作区：/Users/test/.dsh/dsh_orb（默认）')).length, 1)
    const restored = find(view, (node) => node.type === 'button' && node.children?.includes('恢复默认工作区'))[0]
    assert.equal(restored.props.disabled, true)
  })

  it('confirms a retention change before saving, and reverts on cancel', async () => {
    const page = loadSection()
    page.setHistory({
      ...page.snapshot.history,
      retentionDays: 0,
      lastCleanupAt: 1700000000000,
      lastDeletedSessions: 2,
      lastMovedBytes: 3 * 1024 * 1024,
    })
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.type === 'h3' && node.children?.[0] === '旧会话清理').length, 1)
    assert.equal(find(view, (node) => node.children?.includes('工作区：/Users/test/.dsh/dsh_orb')).length, 1)

    let select = find(view, (node) => node.type === 'select' && node.props?.['aria-label'] === '保留期限')[0]
    assert.equal(select.props.value, '0')
    const options = find(select, (node) => node.type === 'option')
    assert.deepEqual(options.map((option) => option.children?.[0]), ['永久保留', '1 天', '7 天', '14 天', '30 天', '60 天'])

    select.props.onChange({ target: { value: '30' } })
    // The dialog opens immediately; the scan result arrives later.
    view = page.render()
    let dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.ok(dialog)
    assert.equal(find(dialog, (node) => node.children?.includes('正在扫描超过 30 天的会话…')).length, 1)
    assert.ok(find(dialog, (node) => node.props?.role === 'progressbar').length > 0)
    const scanningConfirm = find(dialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0]
    assert.equal(scanningConfirm.props.disabled, true)
    const cancel = find(dialog, (node) => node.type === 'button' && node.children?.includes('取消'))[0]
    cancel.props.onClick()
    await settle()
    view = page.render()
    select = find(view, (node) => node.type === 'select' && node.props?.['aria-label'] === '保留期限')[0]
    assert.equal(select.props.value, '0')
    assert.ok(!find(view, (node) => node.props?.role === 'dialog')[0])
    assert.ok(!page.calls.some((call) => call.path === '/.dsh-orb/history/retention'))

    select.props.onChange({ target: { value: '30' } })
    await settle()
    view = page.render()
    dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.ok(dialog)
    assert.equal(find(dialog, (node) => node.children?.includes('确认后，将把 2 个会话清理到系统回收站。')).length, 1)
    assert.equal(find(dialog, (node) => node.children?.includes('以后只保留最近 30 天的会话。')).length, 1)
    assert.equal(find(dialog, (node) => node.children?.includes('会话 A')).length, 1)
    assert.equal(find(dialog, (node) => node.children?.includes('会话 B')).length, 1)
    assert.ok(!page.calls.some((call) => call.path === '/.dsh-orb/history/retention'))
    assert.ok(!page.calls.some((call) => call.path === '/.dsh-orb/history/clean'))
    const confirmButton = find(dialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0]
    confirmButton.props.onClick()
    await settle()
    assert.ok(page.calls.some((call) => call.path === '/.dsh-orb/history/preview'))
    const retention = page.calls.find((call) => call.path === '/.dsh-orb/history/retention')
    assert.equal(JSON.parse(retention.options.body).days, 30)
    assert.ok(page.calls.some((call) => call.path === '/.dsh-orb/history/clean'))
    assert.equal(page.snapshot.history.retentionDays, 30)

    view = page.render()
    select = find(view, (node) => node.type === 'select' && node.props?.['aria-label'] === '保留期限')[0]
    assert.equal(select.props.value, '30')
    assert.equal(find(view, (node) => node.type === 'button' && ['保存', '立即清理', '清空回收站', '恢复'].some((label) => node.children?.includes(label))).length, 0)
    assert.ok(find(view, (node) => node.children?.some?.((child) => typeof child === 'string' && child.includes('系统回收站'))).length > 0)

    // Switching back to forever also asks first, and never starts a cleanup.
    const cleanCalls = page.calls.filter((call) => call.path === '/.dsh-orb/history/clean').length
    select.props.onChange({ target: { value: '0' } })
    await settle()
    view = page.render()
    dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.ok(dialog)
    assert.equal(find(dialog, (node) => node.children?.includes('确认后改为永久保留，不再自动清理会话，也不会删除任何内容。')).length, 1)
    const forever = find(dialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0]
    forever.props.onClick()
    await settle()
    assert.equal(page.snapshot.history.retentionDays, 0)
    assert.equal(page.calls.filter((call) => call.path === '/.dsh-orb/history/clean').length, cleanCalls)

    // Even a window with nothing old enough to delete asks for confirmation before applying.
    const second = loadSection()
    second.setHistory({ ...second.snapshot.history, retentionDays: 7 })
    second.setPreviewRoots(0)
    let secondView = second.render()
    await second.flush()
    secondView = second.render()
    const secondSelect = find(secondView, (node) => node.type === 'select' && node.props?.['aria-label'] === '保留期限')[0]
    secondSelect.props.onChange({ target: { value: '30' } })
    await settle()
    secondView = second.render()
    const secondDialog = find(secondView, (node) => node.props?.role === 'dialog')[0]
    assert.ok(secondDialog)
    assert.equal(find(secondDialog, (node) => node.children?.includes('当前没有超过 30 天的会话需要立即清理。')).length, 1)
    const apply = find(secondDialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0]
    apply.props.onClick()
    await settle()
    assert.equal(second.snapshot.history.retentionDays, 30)
  })

  it('does not offer history controls when the host cannot clean conversations', async () => {
    const page = loadSection()
    page.setHistory({ ...page.snapshot.history, available: false })
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('当前 Harness 或系统回收站不支持清理会话。')).length, 1)
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

    // A manager that still reports already-installed has no removal step. Say so in words.
    page.setUpdate({ updating: false, available: true, error: 'already-installed', pendingBuilds: [] })
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.match(texts(), /更新失败：当前 Harness 不允许覆盖已安装的插件，请在插件页移除后再安装新版本。/)

    // Once installed, the card asks for the restart instead of offering the same version again.
    page.setUpdate({ updating: false, available: false, error: null, restartRequired: true, installedVersion: '0.2.0', latestVersion: '0.2.0' })
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.match(texts(), /已更新到 0\.2\.0，重启 DeepSeek Harness 后生效。/)
    assert.equal(find(view, (node) => node.type === 'button' && text(node) === '更新').length, 0)

    // The host reopened while the after-exit script runs: the card shows the install in
    // progress instead of the quit-and-reopen notice.
    page.setUpdate({ updating: false, available: false, error: null, restartRequired: false, deferred: false, installing: true })
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.match(texts(), /更新正在安装中，安装完成前请不要退出 DeepSeek Harness。/)
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

  it('lets the save win when a slower settings reload answers after it', async () => {
    const held = Promise.withResolvers()
    let armed = false
    const page = loadSection({
      answer: (path, _options, snapshot) => {
        if (!armed || path !== '/.dsh-orb/settings') return undefined
        armed = false
        // What the page showed before the save: this reload arrives late.
        const stale = JSON.stringify({ ...snapshot, ballEnabled: true })
        return { ok: true, status: 200, async text() { await held.promise; return stale } }
      },
    })
    await page.flush()
    const check = () => find(page.render(), (node) => node.props?.['aria-label'] === '启用悬浮球')[0]

    // The helper-runtime poll is armed, and the next settings load is held back.
    page.snapshot.helperPhase = 'downloading'
    page.render()
    await page.flush()
    page.render()
    armed = true
    const ticking = page.tick()
    await settle()
    assert.equal(armed, false, 'a settings load asked and is now in flight')

    // The user saves in the meantime: the ball goes off.
    check().props.onClick()
    await settle()
    assert.equal(check().props['aria-checked'], 'false')

    held.resolve()
    await ticking
    await settle()
    // The late reload must not put the pre-save snapshot back on screen.
    assert.equal(check().props['aria-checked'], 'false')
    page.snapshot.helperPhase = ''
  })

  it('drops a settings reload that was sent before the save landed', async () => {
    const saved = Promise.withResolvers()
    const reloaded = Promise.withResolvers()
    let holdReload = false
    const page = loadSection({
      answer: (path, options, snapshot) => {
        if (options.method === 'POST' && path === '/.dsh-orb/ball') {
          // Same bookkeeping as the default handler, but the answer is held back.
          snapshot.ballEnabled = JSON.parse(options.body).enabled
          return { ok: true, status: 200, async text() { await saved.promise; return JSON.stringify(snapshot) } }
        }
        if (!holdReload || path !== '/.dsh-orb/settings') return undefined
        holdReload = false
        // Captured while the save was still in flight: this reload cannot know about it.
        const stale = JSON.stringify({ ...snapshot, ballEnabled: true })
        return { ok: true, status: 200, async text() { await reloaded.promise; return stale } }
      },
    })
    await page.flush()
    const check = () => find(page.render(), (node) => node.props?.['aria-label'] === '启用悬浮球')[0]

    // The update poll is armed by `installing` too, and the save is held open.
    page.setUpdate({ installing: true })
    page.render()
    await page.flush()
    const view = page.render()
    find(view, (node) => node.props?.['aria-label'] === '启用悬浮球')[0].props.onClick()
    await settle()

    // A poll fires while that save is in flight; its answer is pre-save state.
    holdReload = true
    const ticking = page.tick()
    await settle()
    assert.equal(holdReload, false, 'the poll asked and is now in flight')

    saved.resolve()
    await settle()
    assert.equal(check().props['aria-checked'], 'false', 'the save is on screen')

    reloaded.resolve()
    const intervals = await ticking
    await settle()
    assert.equal(check().props['aria-checked'], 'false', 'a reload sent before the save must not undo it')
    assert.ok(intervals >= 1, 'an install in progress arms the update poll')
    page.setUpdate({ installing: false })
  })

  it('re-enables the page when a save superseded by a newer one finally answers', async () => {
    const held = Promise.withResolvers()
    let hold = false
    const page = loadSection({
      answer: (path, options, snapshot) => {
        if (!hold || options.method !== 'POST' || path !== '/.dsh-orb/ball') return undefined
        hold = false
        snapshot.ballEnabled = JSON.parse(options.body).enabled
        return { ok: true, status: 200, async text() { await held.promise; return JSON.stringify(snapshot) } }
      },
    })
    let view = page.render()
    await page.flush()
    view = page.render()
    const fieldset = () => find(page.render(), (node) => node.type === 'fieldset')[0]
    hold = true
    find(view, (node) => node.props?.['aria-label'] === '启用悬浮球')[0].props.onClick()
    await settle()
    assert.equal(fieldset().props.disabled, true, 'a save in flight disables the fields')

    // A second save outranks the held one; its own answer lands immediately.
    view = page.render()
    find(view, (node) => node.props?.['aria-label'] === '自动检查更新')[0].props.onClick()
    await settle()

    held.resolve()
    await settle()
    assert.equal(fieldset().props.disabled, false, 'the dropped answer must still release the fields')
  })

  it('puts voice settings directly after the two Agent cards', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()
    const fields = find(view, (node) => node.type === 'fieldset')[0]
    const titles = (fields.children || [])
      .filter((node) => node.type === 'section')
      .map((node) => find(node, (child) => child.type === 'h3')[0]?.children?.[0])
    assert.deepEqual(titles.slice(0, 5), ['启用悬浮球', '悬浮球头像', '悬浮球 Agent', '后台 Agent', '语音'])
    assert.equal(titles[5], '千分比坐标', 'coordinate and frame cards stay below the voice panel')
    assert.equal(titles[7], '划词工具栏', 'the selection toolbar sits with the other behaviour toggles')
    assert.equal(titles[8], '空闲后取消固定', 'idle unpin lives outside the voice card')
  })

  it('starts with voice collapsed and expands it from the master switch', async () => {
    const page = loadSection()
    delete page.snapshot.voice
    page.snapshot.voiceModels = readyVoiceModels()
    let view = page.render()
    await page.flush()
    view = page.render()
    const master = find(view, (node) => node.props?.['aria-label'] === '启用语音')[0]
    assert.ok(master)
    assert.equal(master.props['aria-checked'], 'false', 'a fresh profile starts with voice off')
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '语音唤醒').length, 0)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '灵敏度').length, 0)
    assert.equal(find(view, (node) => node.children?.includes('打开总开关后，可以设置唤醒、语音输入和播报。')).length, 1)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '空闲时长（秒）').length, 1, 'idle stays available while voice is off')

    master.props.onClick()
    await settle()
    view = page.render()
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '启用语音')[0].props['aria-checked'], 'true')
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '语音唤醒')[0].props['aria-checked'], 'true', 'the stored column mix comes back')
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '灵敏度').length, 1)
    const saved = JSON.parse(page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1).options.body)
    assert.equal(saved.voiceEnabled, true)
    assert.equal(saved.wakeEnabled, true)
    assert.equal(saved.commandEnabled, true)
    assert.equal(saved.ttsEnabled, true)
  })

  it('collapses the voice form when the master switch goes off and keeps the column choices', async () => {
    const page = loadSection()
    page.snapshot.voiceModels = readyVoiceModels()
    page.snapshot.voice = { ...page.snapshot.voice, wakeEnabled: true, commandEnabled: false, ttsEnabled: true }
    let view = page.render()
    await page.flush()
    view = page.render()
    find(view, (node) => node.props?.['aria-label'] === '启用语音')[0].props.onClick()
    await settle()
    view = page.render()
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '启用语音')[0].props['aria-checked'], 'false')
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '语音唤醒').length, 0)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '语音输入').length, 0)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === 'TTS' && node.props.role === 'switch').length, 0)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '空闲时长（秒）').length, 1)
    const saved = JSON.parse(page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1).options.body)
    assert.equal(saved.voiceEnabled, false)
    assert.equal(saved.wakeEnabled, true, 'the column choices are kept')
    assert.equal(saved.commandEnabled, false, 'the column choices are kept')
    assert.equal(saved.ttsEnabled, true, 'the column choices are kept')
  })

  it('keeps the old effective state when the master field is missing', async () => {
    const page = loadSection()
    page.snapshot.voice = { wakeEnabled: true, commandEnabled: false, ttsEnabled: false }
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '启用语音')[0].props['aria-checked'], 'true')
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '语音唤醒')[0].props['aria-checked'], 'true')

    page.snapshot.voice = { wakeEnabled: false, commandEnabled: false, ttsEnabled: false }
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '启用语音')[0].props['aria-checked'], 'false')
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '语音唤醒').length, 0)
  })

  it('uses sliders for every bounded voice value and writes once when one is released', async () => {
    const page = loadSection()
    page.snapshot.voiceModels = readyVoiceModels()
    let view = page.render()
    await page.flush()
    view = page.render()
    const ranges = find(view, (node) => node.type === 'input' && node.props?.type === 'range')
    for (const label of ['灵敏度', '增强分', '冷却（秒）', '音量', '语速', '空闲时长（秒）']) {
      assert.equal(ranges.some((node) => node.props['aria-label'] === label), true, `${label} is a slider`)
    }
    assert.equal(find(view, (node) => node.type === 'input' && node.props?.type === 'number').length, 0, 'no bounded value asks for a typed number')
    const chunk = find(view, (node) => node.props?.role === 'radiogroup' && node.props?.['aria-label'] === '判定粒度')[0]
    assert.ok(chunk, 'the two fixed chunk sizes are buttons, not a slider')

    const threshold = ranges.find((node) => node.props['aria-label'] === '灵敏度')
    threshold.props.onChange({ target: { value: '0.35' } })
    view = page.render()
    const dragged = find(view, (node) => node.props?.['aria-label'] === '灵敏度')[0]
    assert.equal(dragged.props.value, '0.35')
    assert.equal(dragged.props['aria-valuetext'], '0.35')
    dragged.props.onPointerUp({ target: { value: '0.35' } })
    await settle()
    const saved = JSON.parse(page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1).options.body)
    assert.equal(saved.wakeThreshold, 0.35)
    const before = page.calls.length
    dragged.props.onBlur({ target: { value: '0.35' } })
    await settle()
    assert.equal(page.calls.length, before, 'the release already wrote the value; blur must not write it again')
  })

  it('saves voice settings when the models are present, and hides the ASR button', async () => {
    const page = loadSection()
    page.snapshot.voiceModels = readyVoiceModels()
    let view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('没有拿到麦克风，唤醒和语音输入都不会发生。球的其他功能照常。')).length, 0)
    page.snapshot.voiceMic = false
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    const mic = find(view, (node) => node.type === 'button' && node.children?.includes('打开「麦克风」设置'))[0]
    assert.ok(mic)
    mic.props.onClick()
    await settle()
    assert.equal(page.calls.some((call) => call.path === '/.dsh-orb/voice/mic'), true)
    page.snapshot.voiceMic = null
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.type === 'h3' && node.children?.[0] === '语音').length, 1)
    assert.equal(find(view, (node) => node.type === 'button' && node.children?.includes('启动 ASR 语音模型')).length, 0)
    const wake = find(view, (node) => node.props?.['aria-label'] === '语音唤醒')[0]
    assert.equal(wake.props['aria-checked'], 'true')
    wake.props.onClick()
    await settle()
    const saved = page.calls.find((call) => call.path === '/.dsh-orb/voice')
    assert.equal(JSON.parse(saved.options.body).wakeEnabled, false)
    assert.equal(JSON.parse(saved.options.body).wakeReply, '我在')
    view = page.render()
    const idle = find(view, (node) => node.props?.['aria-label'] === '空闲时长（秒）')[0]
    idle.props.onBlur({ target: { value: '45' } })
    await settle()
    const idleCall = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(idleCall.options.body).idleMs, 45000)
    const prompt = find(view, (node) => node.props?.['aria-label'] === '提问提示语')[0]
    prompt.props.onBlur({ target: { value: '你来选' } })
    await settle()
    const promptCall = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(promptCall.options.body).questionPrompt, '你来选')
    const volume = find(view, (node) => node.type === 'input' && node.props?.['aria-label'] === '音量')[0]
    assert.ok(volume)
    assert.equal(volume.props.type, 'range')
    assert.equal(String(volume.props.min), '0')
    assert.equal(String(volume.props.max), '200')
    assert.equal(volume.props.value, '100')
    volume.props.onChange({ target: { value: '65' } })
    view = page.render()
    const changedVolume = find(view, (node) => node.type === 'input' && node.props?.['aria-label'] === '音量')[0]
    assert.equal(changedVolume.props.value, '65')
    assert.equal(changedVolume.props['aria-valuetext'], '65%')
    assert.equal(find(view, (node) => node.children?.includes('65%')).length, 1)
    changedVolume.props.onBlur({ target: { value: '65' } })
    await settle()
    const volumeCall = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(volumeCall.options.body).ttsVolume, 0.65)
    const keyword = find(view, (node) => node.props?.['aria-label'] === '插话关键词')[0]
    assert.equal(String(keyword.props.className).includes('is-locked'), false)
    keyword.props.onBlur({ target: { value: '小肥鱼' } })
    await settle()
    const keywordCall = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(keywordCall.options.body).interjectKeyword, '小肥鱼')
    assert.equal(find(view, (node) => node.children?.includes('按拼音匹配，同音字自动生效，不需要另填别名。')).length, 1)
    find(page.render(), (node) => node.props?.['aria-label'] === '语音输入' && node.props.role === 'switch')[0].props.onClick()
    await settle()
    view = page.render()
    const stillOpen = find(view, (node) => node.props?.['aria-label'] === '插话关键词')[0]
    assert.equal(String(stillOpen.props.className).includes('is-locked'), false)
    stillOpen.props.onBlur({ target: { value: '再插一句' } })
    await settle()
    const afterOff = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(afterOff.options.body).interjectKeyword, '再插一句')
    assert.equal(JSON.parse(afterOff.options.body).commandEnabled, false)
  })

  it('explains the missing model when a locked voice control is clicked', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()
    const before = page.calls.length
    find(view, (node) => node.props?.['aria-label'] === '语音唤醒')[0].props.onClick()
    view = page.render()
    const dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.ok(dialog)
    assert.equal(find(dialog, (node) => node.children?.includes('要下载语音唤醒模型。')).length, 1)
    assert.equal(page.calls.length, before, 'a locked switch does not save')
    find(dialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0].props.onClick()

    view = page.render()
    const keyword = find(view, (node) => node.props?.['aria-label'] === '插话关键词')[0]
    assert.equal(String(keyword.props.className).includes('is-locked'), true)
    const beforeKeyword = page.calls.length
    keyword.props.onClick()
    view = page.render()
    const keywordDialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.equal(find(keywordDialog, (node) => node.children?.includes('要启动 ASR 语音模型。')).length, 1)
    assert.equal(page.calls.length, beforeKeyword, 'a locked interject keyword does not save')
    find(keywordDialog, (node) => node.type === 'button' && node.children?.includes('确定'))[0].props.onClick()

    view = page.render()
    find(view, (node) => node.props?.['aria-label'] === '唤醒后的回复语')[0].props.onClick()
    view = page.render()
    const both = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.equal(find(both, (node) => node.children?.includes('要下载语音唤醒模型。')).length, 1)
    assert.equal(find(both, (node) => node.children?.includes('要下载 TTS 模型。')).length, 1)
    assert.equal(find(both, (node) => node.children?.includes('要启动 ASR 语音模型。')).length, 0)

    page.snapshot.voiceModels = {
      wake: { present: true },
      tts: { present: false },
      asr: { present: true },
    }
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    find(view, (node) => node.props?.['aria-label'] === '退下后的回复语')[0].props.onClick()
    view = page.render()
    const reply = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.equal(find(reply, (node) => node.children?.includes('要下载 TTS 模型。')).length, 1)
    assert.equal(find(reply, (node) => node.children?.includes('要下载语音唤醒模型。')).length, 0)
    const idle = find(view, (node) => node.props?.['aria-label'] === '空闲时长（秒）')[0]
    assert.equal(String(idle.props.className).includes('is-locked'), false)
    idle.props.onBlur({ target: { value: '12' } })
    await settle()
    assert.equal(JSON.parse(page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1).options.body).idleMs, 12000)
  })

  it('confirms a model download, shows progress, and does not offer ASR once it exists', async () => {
    const page = loadSection()
    let view = page.render()
    await page.flush()
    view = page.render()
    const button = find(view, (node) => node.type === 'button' && node.children?.includes('下载语音唤醒模型'))[0]
    assert.match(button.props.className, /dsh-orb-set-primary/)
    const asr = find(view, (node) => node.type === 'button' && node.children?.includes('启动 ASR 语音模型'))[0]
    assert.ok(asr)
    page.snapshot.voiceModels = { wake: { present: false }, tts: { present: false }, asr: { present: false, official: false } }
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    const beforeAsr = page.calls.length
    find(view, (node) => node.type === 'button' && node.children?.includes('启动 ASR 语音模型'))[0].props.onClick()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('当前 DeepSeek Harness 没有官方语音识别服务，插件不会自己另下一份。')).length, 1)
    assert.equal(page.calls.length, beforeAsr)
    page.snapshot.voiceModels = undefined
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    find(view, (node) => node.type === 'button' && node.children?.includes('下载语音唤醒模型'))[0].props.onClick()
    view = page.render()
    const dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.equal(find(dialog, (node) => node.children?.includes('https://registry.npmmirror.com/dsh-orb-kws/-/dsh-orb-kws-2026.10.0.tgz')).length, 1)
    assert.equal(find(dialog, (node) => node.children?.includes('https://registry.npmjs.org/dsh-orb-kws/-/dsh-orb-kws-2026.10.0.tgz')).length, 1)
    assert.equal(find(dialog, (node) => node.children?.includes('约 9 MB')).length, 1)
    const before = page.calls.length
    find(dialog, (node) => node.type === 'button' && node.children?.includes('取消'))[0].props.onClick()
    assert.equal(page.calls.length, before)
    view = page.render()
    find(view, (node) => node.type === 'button' && node.children?.includes('下载语音唤醒模型'))[0].props.onClick()
    view = page.render()
    find(find(view, (node) => node.props?.role === 'dialog')[0], (node) => node.type === 'button' && node.children?.includes('下载'))[0].props.onClick()
    await settle()
    const download = page.calls.filter((call) => call.path === '/.dsh-orb/voice/download').at(-1)
    assert.deepEqual(JSON.parse(download.options.body), { kind: 'wake' })

    page.snapshot.voiceModels = {
      wake: { present: false, downloading: true, progress: 0.4 },
      tts: { present: false },
      asr: { present: true },
    }
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.type === 'button' && node.children?.includes('启动 ASR 语音模型')).length, 0)
    const bar = find(view, (node) => node.props?.role === 'progressbar')[0]
    assert.equal(bar.props['aria-valuenow'], 40)
    assert.equal(find(view, (node) => node.children?.includes('已下载 40%')).length, 1)
    const calls = page.calls.length
    find(view, (node) => node.type === 'button' && node.children?.includes('下载语音唤醒模型'))[0].props.onClick()
    await settle()
    assert.equal(page.calls.length, calls, 'a download in progress does not start another')

    page.snapshot.voiceModels = readyVoiceModels()
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    const again = find(view, (node) => node.type === 'button' && node.children?.includes('重新下载'))[0]
    assert.match(again.props.className, /dsh-orb-set-ghost/)
    again.props.onClick()
    await settle()
    view = page.render()
    assert.equal(find(view, (node) => node.children?.includes('模型已经存在，不需要重新下载')).length, 1)
  })

  it('switches the speech backend and saves the qwen fields', async () => {
    const page = loadSection()
    page.snapshot.voiceModels = readyVoiceModels()
    let view = page.render()
    await page.flush()
    view = page.render()
    const backend = find(view, (node) => node.props?.role === 'radiogroup' && node.props?.['aria-label'] === '播报方式')[0]
    assert.ok(backend)
    const localOption = find(backend, (node) => node.props?.role === 'radio' && node.children?.includes('本地模型'))[0]
    assert.equal(localOption.props['aria-checked'], 'true')
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '阿里云百炼 API Key').length, 0)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '语速').length, 1)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '音量').length, 1)
    assert.equal(find(ttsPanel(view), (node) => String(node.props?.className).includes('dsh-orb-set-voice-model-block')).length, 1, 'the local backend shows its model row')

    find(backend, (node) => node.props?.role === 'radio' && node.children?.includes('千问'))[0].props.onClick()
    await settle()
    const firstSave = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(firstSave.options.body).ttsBackend, 'qwen')
    assert.equal(JSON.parse(firstSave.options.body).qwenVoice, 'Cherry')

    view = page.render()
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '音量').length, 1, 'the shared volume stays visible for qwen')
    const key = find(view, (node) => node.props?.['aria-label'] === '阿里云百炼 API Key')[0]
    assert.ok(key)
    assert.equal(key.props.type, 'password')
    assert.equal(find(view, (node) => node.children?.includes('留空时不播报。')).length, 1)
    assert.equal(find(view, (node) => node.children?.includes('云端 TTS 使用阿里云百炼的千问语音合成，不是 DeepSeek API。')).length, 1)
    const bailian = find(view, (node) => node.type === 'a' && node.props?.href === 'https://bailian.console.aliyun.com/?apiKey=1#/api-key')[0]
    assert.ok(bailian)
    assert.equal(bailian.props.target, '_blank')
    assert.equal(bailian.props.rel, 'noopener noreferrer')
    assert.equal(bailian.children?.includes('去百炼控制台获取 API Key'), true)
    const voice = find(view, (node) => node.type === 'select' && node.props?.['aria-label'] === '音色')[0]
    assert.ok(voice)
    assert.equal(voice.props.value, 'Cherry')
    assert.equal(find(voice, (node) => node.type === 'optgroup').length, 2)
    assert.equal(find(voice, (node) => node.type === 'option' && node.props.value === 'Eldric Sage').length, 1)
    const speed = find(view, (node) => node.props?.['aria-label'] === '语速')[0]
    assert.equal(String(speed.props.min), '0.5')
    assert.equal(String(speed.props.max), '2')

    key.props.onBlur({ target: { value: '  sk-test  ' } })
    await settle()
    assert.equal(JSON.parse(page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1).options.body).qwenApiKey, '  sk-test  ')

    voice.props.onChange({ target: { value: 'Eldric Sage' } })
    await settle()
    const voiceSave = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(voiceSave.options.body).qwenVoice, 'Eldric Sage')

    view = page.render()
    find(view, (node) => node.props?.['aria-label'] === '语速')[0].props.onBlur({ target: { value: '1.8' } })
    await settle()
    assert.equal(JSON.parse(page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1).options.body).qwenSpeed, 1.8)
    view = page.render()
    const qwenVolume = find(view, (node) => node.type === 'input' && node.props?.['aria-label'] === '音量')[0]
    qwenVolume.props.onChange({ target: { value: '150' } })
    view = page.render()
    find(view, (node) => node.type === 'input' && node.props?.['aria-label'] === '音量')[0].props.onBlur({ target: { value: '150' } })
    await settle()
    assert.equal(JSON.parse(page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1).options.body).ttsVolume, 1.5)
    const qwenPanel = ttsPanel(view)
    assert.ok(qwenPanel)
    assert.equal(find(qwenPanel, (node) => String(node.props?.className).includes('dsh-orb-set-voice-model-block')).length, 0, 'qwen hides the local model row')
    assert.equal(find(qwenPanel, (node) => node.type === 'button' && node.children?.includes('重新下载')).length, 0)
  })

  it('unlocks speech controls for qwen even without the local model', async () => {
    const page = loadSection()
    page.snapshot.voiceModels = { wake: { present: true }, tts: { present: false }, asr: { present: true } }
    page.snapshot.voice = { ...page.snapshot.voice, ttsBackend: 'qwen', qwenApiKey: 'sk-test' }
    let view = page.render()
    await page.flush()
    view = page.render()
    const tts = find(view, (node) => node.props?.['aria-label'] === 'TTS' && node.props.role === 'switch')[0]
    assert.equal(tts.props['aria-disabled'], undefined)
    for (const label of ['提问提示语', '唤醒后的回复语', '退下后的回复语', '音量']) {
      const field = find(view, (node) => node.props?.['aria-label'] === label)[0]
      assert.equal(String(field.props.className).includes('is-locked'), false, label)
    }
    assert.equal(find(ttsPanel(view), (node) => String(node.props?.className).includes('dsh-orb-set-voice-model-block')).length, 0, 'qwen hides the missing local model row')
    tts.props.onClick()
    await settle()
    const saved = page.calls.filter((call) => call.path === '/.dsh-orb/voice').at(-1)
    assert.equal(JSON.parse(saved.options.body).ttsEnabled, false)
    assert.equal(find(page.render(), (node) => node.props?.role === 'dialog').length, 0)

    page.snapshot.voice = { ...page.snapshot.voice, ttsBackend: 'local' }
    page.reset()
    view = page.render()
    await page.flush()
    view = page.render()
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '阿里云百炼 API Key').length, 0)
    assert.equal(find(view, (node) => node.props?.['aria-label'] === '音色').length, 0)
    const localSpeed = find(view, (node) => node.props?.['aria-label'] === '语速')[0]
    assert.equal(String(localSpeed.props.min), '1')
    assert.equal(String(localSpeed.props.max), '3')
    const localVolume = find(view, (node) => node.props?.['aria-label'] === '音量')[0]
    assert.equal(String(localVolume.props.className).includes('is-locked'), true, 'the local volume waits for the model')
    const localModel = find(ttsPanel(view), (node) => String(node.props?.className).includes('dsh-orb-set-voice-model-block'))[0]
    assert.ok(localModel, 'the local backend brings the model row back')
    const ttsDownload = find(localModel, (node) => node.type === 'button' && node.children?.includes('下载 TTS 语音播报模型'))[0]
    assert.ok(ttsDownload)
    assert.match(ttsDownload.props.className, /dsh-orb-set-primary/)
    const locked = find(view, (node) => node.props?.['aria-label'] === 'TTS' && node.props.role === 'switch')[0]
    assert.equal(locked.props['aria-disabled'], 'true')
    locked.props.onClick()
    view = page.render()
    const dialog = find(view, (node) => node.props?.role === 'dialog')[0]
    assert.equal(find(dialog, (node) => node.children?.includes('要下载 TTS 模型。')).length, 1)
  })
})

function readyVoiceModels() {
  const model = { present: true, downloading: false, progress: 0 }
  return { wake: { ...model }, tts: { ...model }, asr: { ...model } }
}

/** The TTS panel, found by its heading rather than by position in the voice card. */
function ttsPanel(view) {
  return find(view, (node) => String(node.props?.className).includes('dsh-orb-set-voice-panel')
    && find(node, (child) => child.type === 'h4' && child.children?.includes('TTS')).length === 1)[0]
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}
