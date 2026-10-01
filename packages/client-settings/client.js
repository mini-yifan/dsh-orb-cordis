window.__ModuleLoader__.load({
  id: '@dsh-orb/client-ui-settings-orb',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const zh = {
      nav: '悬浮球',
      intro: '更改写入当前配置。',
      linux: '悬浮球在 Linux 上不可用。',
      error: '无法加载悬浮球设置。',
      saveError: '无法保存。',
      helperFailed: '悬浮球多次退出，已经停止重试。关闭后再打开可再试一次。',
      runtimeFailed: '悬浮球运行时没有下载成功。请确认网络能访问 github.com 或 npmmirror.com 后，关闭再打开重试。',
      permissionFallback: '权限设置无法读取，已改为工作区内修改。',
      retry: '重试',
      ball: '启用悬浮球',
      ballDescription: '关闭后插件仍在，Computer Use 仍可在主窗口使用。',
      avatarTitle: '悬浮球头像',
      avatarDescription: '点一张内置动图，或选择自己的图片。上传支持 GIF、PNG、WebP，2 MB 以内。',
      avatarAlt: '悬浮球头像预览',
      avatarBuiltin: '内置动图',
      avatarPresetNames: {
        point: '指点',
        rice: '干饭',
        heart: '比心',
        cheer: '欢呼',
        cheeks: '托腮',
        smile: '微笑',
      },
      chooseImage: '选择图片',
      restoreDefault: '恢复默认',
      tooLarge: '图片超过 2 MB。',
      invalidType: '请选择 GIF、PNG 或 WebP 图片。',
      overlayTitle: '悬浮球 Agent',
      overlayDescription: '悬浮球 Computer Use 会话使用的模型与思考强度。',
      backgroundTitle: '后台 Agent',
      backgroundDescription: '新建后台 code_agent 会话使用的模型与思考强度。',
      emptyCatalog: '暂无可用模型。',
      defaultEffort: '默认',
      millifractionTitle: '千分比坐标',
      hotkeyTitle: '全局快捷键',
      hotkeyDescription: '在系统任意位置一键呼出或隐藏悬浮球。默认关闭；键位被其他程序占用时无法注册。',
      hotkeyToggle: '启用全局快捷键',
      hotkeyAccelerator: '键位',
      millifractionDescription: '新建对话使用截图的 0–1000 比例。关闭后使用已附加图片的像素。更改此项会新建对话。',
      millifractionToggle: '使用千分比坐标',
      millifractionConfirm: '新编码只在新对话中生效。当前对话不变，仍可从历史记录打开。取消不写入、不新建。',
      tccTitle: 'Mac 权限',
      tccDescription: 'Computer Use 需要屏幕录制与辅助功能。点按钮打开系统设置对应页。',
      tccAppHint: '在列表里打开 {name}。',
      tccScreenName: '屏幕录制',
      tccScreenReason: '让 agent 看见当前窗口。',
      tccScreenPath: '系统设置 → 隐私与安全性 → 屏幕录制',
      tccScreenOpen: '打开「屏幕录制」设置',
      tccAccessibilityName: '辅助功能',
      tccAccessibilityReason: '让 agent 点击和输入。',
      tccAccessibilityPath: '系统设置 → 隐私与安全性 → 辅助功能',
      tccAccessibilityOpen: '打开「辅助功能」设置',
      tccMissing: '未开启',
      tccGranted: '已开启',
      tccRelaunch: '已开启，请退出后重开',
      tccFooter: '打开开关后必须完全退出 {name} 再打开。只关主窗口无效。',
    }
    const en = {
      nav: 'Floating ball',
      intro: 'Changes are saved in the current profile.',
      linux: 'The floating ball is not available on Linux.',
      error: 'Could not load floating-ball settings.',
      saveError: 'Could not save.',
      helperFailed: 'The floating ball exited too many times and stopped retrying. Turn it off and on to try again.',
      runtimeFailed: 'The floating-ball runtime did not download. Check that github.com or npmmirror.com is reachable, then turn it off and on to retry.',
      permissionFallback: 'The permission file could not be read. Access is now Workspace Write.',
      retry: 'Retry',
      ball: 'Enable the floating ball',
      ballDescription: 'Turning this off keeps the plugin loaded. Computer Use stays available in the main window.',
      avatarTitle: 'Ball image',
      avatarDescription: 'Pick a built-in animation, or choose your own image. Uploads accept GIF, PNG, and WebP up to 2 MB.',
      avatarAlt: 'Floating-ball image preview',
      avatarBuiltin: 'Built-in animations',
      avatarPresetNames: {
        point: 'Point',
        rice: 'Rice',
        heart: 'Heart',
        cheer: 'Cheer',
        cheeks: 'Cheeks',
        smile: 'Smile',
      },
      chooseImage: 'Choose image',
      restoreDefault: 'Restore default',
      tooLarge: 'The image is larger than 2 MB.',
      invalidType: 'Choose a GIF, PNG, or WebP image.',
      overlayTitle: 'Floating-ball Agent',
      overlayDescription: 'Model and reasoning effort for the ball\'s Computer Use session.',
      backgroundTitle: 'Background Agent',
      backgroundDescription: 'Model and reasoning effort for new background code_agent sessions.',
      emptyCatalog: 'No models available.',
      defaultEffort: 'Default',
      millifractionTitle: 'Millifraction coordinates',
      hotkeyTitle: 'Global hotkey',
      hotkeyDescription: 'Summon or hide the floating ball from anywhere in the system. Off by default; the key cannot register while another app holds it.',
      hotkeyToggle: 'Enable the global hotkey',
      hotkeyAccelerator: 'Key combination',
      millifractionDescription: 'New chats use 0–1000 fractions of the screenshot. Turn off to use pixels of the attached image. Changing this creates a new conversation.',
      millifractionToggle: 'Use millifraction coordinates',
      millifractionConfirm: 'The new encoding takes effect in a new conversation. The current conversation stays unchanged and remains in History. Cancel leaves the default and this chat as they are.',
      tccTitle: 'Mac permissions',
      tccDescription: 'Computer Use needs Screen Recording and Accessibility. Each button opens that System Settings pane.',
      tccAppHint: 'In the list, turn on {name}.',
      tccScreenName: 'Screen Recording',
      tccScreenReason: 'Lets the agent see the current window.',
      tccScreenPath: 'System Settings → Privacy & Security → Screen Recording',
      tccScreenOpen: 'Open Screen Recording settings',
      tccAccessibilityName: 'Accessibility',
      tccAccessibilityReason: 'Lets the agent click and type.',
      tccAccessibilityPath: 'System Settings → Privacy & Security → Accessibility',
      tccAccessibilityOpen: 'Open Accessibility settings',
      tccMissing: 'Off',
      tccGranted: 'On',
      tccRelaunch: 'On — quit and reopen',
      tccFooter: 'After you turn the switches on, quit {name} fully, then open it again. Closing the main window does not quit.',
    }

    // The main window's resolved locale rides <html lang> (dsh-client-locale);
    // a page without it falls back to the browser languages.
    function copy() {
      const lang = `${document.documentElement?.lang || ''}${navigator.language || ''}`
      return lang.toLowerCase().startsWith('zh') ? zh : en
    }

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    async function request(path, options) {
      const response = await fetch(path, {
        cache: 'no-store',
        ...options,
        headers: {
          accept: 'application/json',
          ...(options && options.headers ? options.headers : {}),
        },
      })
      const text = await response.text()
      let body = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = { error: text.slice(0, 200) }
        }
      }
      if (!response.ok) {
        const error = new Error(body && body.error ? body.error : 'request failed')
        error.status = response.status
        throw error
      }
      return body
    }

    function findModel(catalog, selection) {
      const groups = catalog && catalog.groups ? catalog.groups : []
      for (const group of groups) {
        if (!selection || group.id !== selection.provider) continue
        for (const model of group.models || []) {
          if (model.id === selection.model) return model
        }
      }
      return undefined
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: `dsh-orb-set-switch${props.checked ? ' is-on' : ''}`,
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: () => {
          if (!props.disabled) props.onChange(!props.checked)
        },
      })
    }

    function ModelPicker(props) {
      const text = copy()
      const groups = props.catalog && props.catalog.groups ? props.catalog.groups : []
      const current = props.current || { provider: '', model: '' }
      const value = `${current.provider}\u001f${current.model}`
      const known = findModel(props.catalog, current)
      const options = []
      if (!known && current.provider && current.model) {
        options.push(h('option', { key: value, value }, `${current.provider} / ${current.model}`))
      }
      for (const group of groups) {
        options.push(h('optgroup', { key: group.id, label: group.name },
          ...(group.models || []).map((model) => h('option', {
            key: `${group.id}\u001f${model.id}`,
            value: `${group.id}\u001f${model.id}`,
          }, model.name))))
      }
      const efforts = known && known.reasoning ? known.reasoning.efforts || [] : []
      return h('div', { className: 'dsh-orb-set-pickers' },
        h('select', {
          'aria-label': props.label,
          disabled: props.disabled || (options.length === 0),
          value: options.length === 0 ? '' : value,
          onChange: (event) => {
            const [provider, model] = String(event.target.value).split('\u001f')
            if (!provider || !model) return
            const next = findModel(props.catalog, { provider, model })
            const effort = next && next.reasoning ? next.reasoning.defaultEffort : undefined
            props.onSelect(effort ? { provider, model, reasoningEffort: effort } : { provider, model })
          },
        }, options.length === 0 ? h('option', { value: '' }, text.emptyCatalog) : options),
        efforts.length === 0 ? null : h('select', {
          'aria-label': text.defaultEffort,
          disabled: props.disabled,
          value: current.reasoningEffort || known.reasoning.defaultEffort || efforts[0].id,
          onChange: (event) => {
            props.onSelect({ provider: current.provider, model: current.model, reasoningEffort: event.target.value })
          },
        }, efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))))
    }

    function statusText(text, state) {
      if (state === 'granted') return text.tccGranted
      if (state === 'needsRelaunch') return text.tccRelaunch
      return text.tccMissing
    }

    function OrbSettingsSection() {
      const text = copy()
      // Re-render when the app's locale changes (<html lang>), so every copy()
      // call in this section re-evaluates against the new language.
      const [, bumpLocale] = React.useState(0)
      React.useEffect(() => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return undefined
        const observer = new MutationObserver(() => { bumpLocale((count) => count + 1) })
        observer.observe(document.documentElement, { attributeFilter: ['lang'] })
        return () => { observer.disconnect() }
      }, [])
      const [state, setState] = React.useState({
        status: 'loading',
        error: '',
        snapshot: null,
        catalog: { groups: [] },
        busy: false,
        avatarError: '',
      })

      async function load() {
        setState((prev) => ({ ...prev, status: prev.snapshot ? prev.status : 'loading', error: '', avatarError: '' }))
        try {
          const [snapshot, catalog] = await Promise.all([
            request('/.dsh-orb/settings'),
            request('/.dsh-orb/models'),
          ])
          setState({ status: 'ready', error: '', snapshot, catalog: catalog || { groups: [] }, busy: false, avatarError: '' })
        } catch (error) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }

      React.useEffect(() => {
        void load()
        const onFocus = () => { void load() }
        window.addEventListener?.('focus', onFocus)
        return () => { window.removeEventListener?.('focus', onFocus) }
      }, [])

      async function mutate(path, body, avatarError) {
        setState((prev) => ({ ...prev, busy: true, avatarError: avatarError || '' }))
        try {
          const snapshot = await request(path, {
            method: 'POST',
            headers: body instanceof ArrayBuffer
              ? { 'content-type': 'application/octet-stream' }
              : { 'content-type': 'application/json' },
            body: body instanceof ArrayBuffer ? body : JSON.stringify(body),
          })
          setState((prev) => ({ ...prev, status: 'ready', snapshot, busy: false, avatarError: '' }))
        } catch (error) {
          const code = error instanceof Error ? error.message : ''
          setState((prev) => ({
            ...prev,
            busy: false,
            avatarError: code === 'too-large' || code === 'invalid-type' ? code : prev.avatarError,
            error: code === 'too-large' || code === 'invalid-type' ? '' : code,
            status: code === 'too-large' || code === 'invalid-type' ? prev.status : 'error',
          }))
        }
      }

      if (state.status === 'error' && !state.snapshot) {
        return h('div', { className: 'dsh-orb-set' },
          h('p', { className: 'dsh-orb-set-error', role: 'alert' }, `${text.error} ${state.error}`),
          h('button', { type: 'button', className: 'dsh-orb-set-button', onClick: () => { void load() } }, text.retry))
      }
      if (!state.snapshot) return h('div', { className: 'dsh-orb-set' }, h('p', null, text.nav))

      const snap = state.snapshot
      const disabled = !snap.supported || state.busy
      const avatarMessage = state.avatarError === 'too-large'
        ? text.tooLarge
        : state.avatarError === 'invalid-type'
          ? text.invalidType
          : ''
      return h('div', { className: 'dsh-orb-set' },
        h('h2', { className: 'dsh-orb-set-title' }, text.nav),
        h('p', { className: 'dsh-orb-set-intro' }, text.intro),
        state.status === 'error' && state.error
          ? h('p', { className: 'dsh-orb-set-error', role: 'alert' }, `${text.saveError} ${state.error}`)
          : null,
        snap.supported ? null : h('p', { className: 'dsh-orb-set-banner', role: 'status' }, text.linux),
        helperNotice(text, snap),
        snap.permissionFallback === true
          ? h('p', { className: 'dsh-orb-set-banner', role: 'status' }, text.permissionFallback)
          : null,
        h('fieldset', { className: 'dsh-orb-set-fields', disabled },
          card(text.ball, text.ballDescription, h(Toggle, {
            checked: snap.ballEnabled === true,
            label: text.ball,
            disabled,
            onChange: (enabled) => { void mutate('/.dsh-orb/ball', { enabled }) },
          })),
          h('section', { className: 'dsh-orb-set-card' },
            h('h3', null, text.avatarTitle),
            h('p', null, text.avatarDescription),
            h('div', { className: 'dsh-orb-set-avatar-row' },
              h('img', { className: 'dsh-orb-set-avatar', src: snap.avatarUrl, alt: text.avatarAlt }),
              h('div', { className: 'dsh-orb-set-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsh-orb-set-button',
                  disabled,
                  onClick: () => {
                    const input = document.createElement('input')
                    input.type = 'file'
                    input.accept = 'image/gif,image/png,image/webp,.gif,.png,.webp'
                    input.onchange = () => {
                      const file = input.files && input.files[0]
                      if (!file) return
                      if (file.size > 2 * 1024 * 1024) {
                        setState((prev) => ({ ...prev, avatarError: 'too-large' }))
                        return
                      }
                      void file.arrayBuffer().then((bytes) => mutate('/.dsh-orb/avatar', bytes))
                    }
                    input.click()
                  },
                }, text.chooseImage),
                h('button', {
                  type: 'button',
                  className: 'dsh-orb-set-button dsh-orb-set-ghost',
                  disabled,
                  onClick: () => { void mutate('/.dsh-orb/avatar/restore', {}) },
                }, text.restoreDefault))),
            avatarMessage ? h('p', { className: 'dsh-orb-set-error', role: 'alert' }, avatarMessage) : null,
            presetGallery(text, snap, disabled, mutate)),
          card(text.overlayTitle, text.overlayDescription, h(ModelPicker, {
            label: text.overlayTitle,
            catalog: state.catalog,
            current: snap.overlay,
            disabled,
            onSelect: (selection) => { void mutate('/.dsh-orb/overlay-model', selection) },
          })),
          card(text.backgroundTitle, text.backgroundDescription, h(ModelPicker, {
            label: text.backgroundTitle,
            catalog: state.catalog,
            current: snap.background,
            disabled,
            onSelect: (selection) => { void mutate('/.dsh-orb/background-model', selection) },
          })),
          card(text.millifractionTitle, text.millifractionDescription, h(Toggle, {
            checked: snap.millifractionEnabled === true,
            label: text.millifractionToggle,
            disabled,
            onChange: (enabled) => {
              if (enabled === snap.millifractionEnabled) return
              if (!window.confirm(text.millifractionConfirm)) return
              void mutate('/.dsh-orb/millifraction', { enabled })
            },
          })),
          hotkeyCard(text, snap, disabled, mutate),
          snap.tcc && snap.tcc.applicable ? tccCard(text, snap, disabled, mutate) : null))
    }

    /** The hotkey card: summon toggle plus a fixed accelerator preset list. */
    const HOTKEY_KEYS = ['Alt+B', 'Alt+O', 'Control+Alt+B', 'F9']
    function hotkeyCard(text, snap, disabled, mutate) {
      const hotkey = snap.hotkey ?? { enabled: false, accelerator: 'Alt+B' }
      return h('section', { className: 'dsh-orb-set-card dsh-orb-set-row' },
        h('div', null, h('h3', null, text.hotkeyTitle), h('p', null, text.hotkeyDescription)),
        h('div', { className: 'dsh-orb-set-actions' },
          h(Toggle, {
            checked: hotkey.enabled === true,
            label: text.hotkeyToggle,
            disabled,
            onChange: (enabled) => {
              void mutate('/.dsh-orb/hotkey', { enabled, accelerator: hotkey.accelerator })
            },
          }),
          hotkey.enabled === true ? h('select', {
            'aria-label': text.hotkeyAccelerator,
            disabled,
            value: hotkey.accelerator,
            onChange: (event) => {
              void mutate('/.dsh-orb/hotkey', { enabled: true, accelerator: String(event.target.value) })
            },
          }, ...HOTKEY_KEYS.map((key) => h('option', { key, value: key }, key))) : null))
    }

    function helperNotice(text, snap) {
      if (snap.helperError === 'helper-exited') {
        return h('p', { className: 'dsh-orb-set-error', role: 'alert' }, text.helperFailed)
      }
      if (snap.helperError === 'runtime-download') {
        return h('p', { className: 'dsh-orb-set-error', role: 'alert' }, text.runtimeFailed)
      }
      return null
    }

    function card(title, description, control) {
      return h('section', { className: 'dsh-orb-set-card dsh-orb-set-row' },
        h('div', null, h('h3', null, title), h('p', null, description)),
        control)
    }

    /** The shipped GIFs as clickable animated thumbnails; the host owns the list, this page the names. */
    function presetGallery(text, snap, disabled, mutate) {
      const presets = Array.isArray(snap.avatarPresets) ? snap.avatarPresets : []
      if (presets.length === 0) return null
      const names = text.avatarPresetNames || {}
      return h('div', { className: 'dsh-orb-set-presets' },
        h('p', { className: 'dsh-orb-set-presets-title', id: 'dsh-orb-presets-label' }, text.avatarBuiltin),
        h('div', { className: 'dsh-orb-set-presets-row', role: 'group', 'aria-labelledby': 'dsh-orb-presets-label' },
          ...presets.map((preset) => {
            const name = names[preset.id] || preset.id
            const selected = snap.avatarPresetId === preset.id
            return h('button', {
              key: preset.id,
              type: 'button',
              className: `dsh-orb-set-preset${selected ? ' is-selected' : ''}`,
              'aria-pressed': selected ? 'true' : 'false',
              title: name,
              disabled,
              onClick: () => { void mutate('/.dsh-orb/avatar/preset', { preset: preset.id }) },
            },
              h('img', { src: preset.url, alt: '', draggable: false }),
              h('span', null, name))
          })))
    }

    function tccCard(text, snap, disabled, mutate) {
      const name = snap.tcc.appName || ''
      return h('section', { className: 'dsh-orb-set-card' },
        h('h3', null, text.tccTitle),
        h('p', null, text.tccDescription),
        h('p', null, text.tccAppHint.replaceAll('{name}', name)),
        tccRow(text.tccScreenName, text.tccScreenReason, text.tccScreenPath, statusText(text, snap.tcc.screen), text.tccScreenOpen, disabled || snap.tcc.screen === 'granted', () => {
          void mutate('/.dsh-orb/tcc', { right: 'screen' })
        }),
        tccRow(text.tccAccessibilityName, text.tccAccessibilityReason, text.tccAccessibilityPath, statusText(text, snap.tcc.accessibility), text.tccAccessibilityOpen, disabled || snap.tcc.accessibility === 'granted', () => {
          void mutate('/.dsh-orb/tcc', { right: 'accessibility' })
        }),
        h('p', null, text.tccFooter.replaceAll('{name}', name)))
    }

    function tccRow(name, reason, path, status, open, disabled, onClick) {
      return h('div', { className: 'dsh-orb-set-tcc' },
        h('div', null,
          h('h4', null, name),
          h('p', null, reason),
          h('p', null, path),
          h('p', { className: 'dsh-orb-set-status' }, status)),
        h('button', { type: 'button', className: 'dsh-orb-set-button', disabled, onClick }, open))
    }

    const style = `
.dsh-orb-set { display: flex; flex-direction: column; gap: 16px; max-width: 720px; color: inherit; }
.dsh-orb-set-title { margin: 0; font-size: 20px; }
.dsh-orb-set-intro, .dsh-orb-set p { margin: 4px 0 0; color: color-mix(in srgb, currentColor 72%, transparent); font-size: 13px; line-height: 1.45; }
.dsh-orb-set-banner, .dsh-orb-set-error { color: inherit; }
.dsh-orb-set-fields { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.dsh-orb-set-card { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; padding: 14px 16px; }
.dsh-orb-set-row, .dsh-orb-set-avatar-row, .dsh-orb-set-tcc { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.dsh-orb-set h3, .dsh-orb-set h4 { margin: 0; font-size: 14px; }
.dsh-orb-set-avatar { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-orb-set-presets { margin-top: 10px; }
.dsh-orb-set-presets-title { margin: 0; font-size: 12px; }
.dsh-orb-set-presets-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.dsh-orb-set-preset { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 72px; padding: 5px 2px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-orb-set-preset img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-orb-set-preset span { font-size: 11px; line-height: 1.2; }
.dsh-orb-set-preset:hover { border-color: color-mix(in srgb, currentColor 20%, transparent); }
.dsh-orb-set-preset.is-selected { border-color: var(--dsw-alias-button-info-fill, #2f6fed); }
.dsh-orb-set-actions, .dsh-orb-set-pickers { display: flex; gap: 8px; align-items: center; }
.dsh-orb-set-button, .dsh-orb-set select { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 6px 10px; font: inherit; }
.dsh-orb-set-ghost { border-color: transparent; }
.dsh-orb-set-switch { width: 40px; height: 24px; border-radius: 999px; border: 0; background: color-mix(in srgb, currentColor 18%, transparent); position: relative; flex: none; }
.dsh-orb-set-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-static-neutral-bluish-00, white); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 120ms ease; }
.dsh-orb-set-switch.is-on { background: var(--dsw-alias-button-info-fill, #2f6fed); }
.dsh-orb-set-switch.is-on::after { transform: translateX(16px); }
.dsh-orb-set-tcc { margin-top: 12px; }
.dsh-orb-set-status { font-weight: 600; }
.dsh-orb-set-fields:disabled { opacity: 0.55; }
`

    const inject = ['slots']

    function apply(ctx) {
      if (!document.getElementById('dsh-orb-settings-style')) {
        const node = document.createElement('style')
        node.id = 'dsh-orb-settings-style'
        node.textContent = style
        document.head.append(node)
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'orb',
        order: 25,
        label: () => copy().nav,
        inject: () => ({}),
      }, OrbSettingsSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
