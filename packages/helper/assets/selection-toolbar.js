const api = window.dshOrb

function applyLanguage(language) {
  document.querySelector('#language-zh').setAttribute('aria-checked', language === 'zh' ? 'true' : 'false')
  document.querySelector('#language-en').setAttribute('aria-checked', language === 'en' ? 'true' : 'false')
}

// Bar labels mirror the main window's language (the appearance message); the
// theme mirrors the ball's nativeTheme, with the system scheme as the fallback.
let uiZh = (navigator.language || '').toLowerCase().startsWith('zh')

function applyUiLanguage(zh) {
  uiZh = zh
  document.querySelector('#search').textContent = zh ? '搜索' : 'Search'
  document.querySelector('#translate').textContent = zh ? '翻译' : 'Translate'
  document.querySelector('#send-to-agent').textContent = zh ? '发给 Agent' : 'Send to Agent'
  document.querySelector('#translate-arrow').setAttribute('aria-label', zh ? '翻译语言' : 'Translate language')
}

function applyDark(dark) {
  document.body.toggleAttribute('data-ds-dark-theme', dark === true)
}

if (typeof api.selection.onAppearance === 'function') {
  api.selection.onAppearance((appearance) => {
    if (appearance === null || typeof appearance !== 'object') return
    applyDark(appearance.dark)
    applyUiLanguage(appearance.locale !== 'en')
  })
}
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
applyDark(darkQuery.matches)
darkQuery.addEventListener('change', (event) => { applyDark(event.matches) })
applyUiLanguage(uiZh)

function placeMenu() {
  const group = document.querySelector('#translate-group')
  document.querySelector('#language-menu').style.left = `${String(group.offsetLeft)}px`
}

async function syncToolbarSize() {
  const bar = document.querySelector('#bar').getBoundingClientRect()
  const menu = document.querySelector('#language-menu')
  const menuRect = menu.hidden ? bar : menu.getBoundingClientRect()
  const left = Math.min(bar.left, menuRect.left)
  const top = Math.min(bar.top, menuRect.top)
  const layout = await api.selection.setContentSize({
    width: Math.max(1, Math.ceil(Math.max(bar.right, menuRect.right) - left)),
    height: Math.max(1, Math.ceil(Math.max(bar.bottom, menuRect.bottom) - top)),
  })
  // The helper picks the direction, because only it knows where the screen edges are and
  // which side the bar was placed on relative to the selected text.
  const side = layout?.side ?? (layout?.menuAbove ? 'above' : 'below')
  document.body.classList.toggle('menu-above', side === 'above')
  document.body.classList.toggle('menu-side', side === 'right' || side === 'left')
  document.body.classList.toggle('menu-left', side === 'left')
  // A sideways layout may grow the window above the bar; shifting the bar down by the same
  // amount is what keeps it on screen exactly where the user saw it.
  const offset = Number(layout?.barOffsetY) || 0
  document.body.style.setProperty('--bar-offset', `${offset}px`)
}

function closeMenu() {
  const menu = document.querySelector('#language-menu')
  if (menu.hidden) return
  menu.hidden = true
  document.body.classList.remove('menu-above', 'menu-side', 'menu-left')
  void syncToolbarSize()
}

document.querySelector('#language-zh').textContent = '中文'
document.querySelector('#language-en').textContent = 'English'

document.querySelector('#search').addEventListener('click', () => { api.selection.search() })
document.querySelector('#translate').addEventListener('click', () => { api.selection.translate() })
document.querySelector('#send-to-agent').addEventListener('click', () => { api.selection.sendToAgent() })
document.querySelector('#translate-arrow').addEventListener('click', (event) => {
  event.stopPropagation()
  const menu = document.querySelector('#language-menu')
  menu.hidden = !menu.hidden
  if (!menu.hidden) placeMenu()
  void syncToolbarSize()
})
document.querySelector('#language-zh').addEventListener('click', () => {
  document.querySelector('#language-menu').hidden = true
  document.body.classList.remove('menu-above', 'menu-side', 'menu-left')
  api.selection.setLanguage('zh')
  void syncToolbarSize()
})
document.querySelector('#language-en').addEventListener('click', () => {
  document.querySelector('#language-menu').hidden = true
  document.body.classList.remove('menu-above', 'menu-side', 'menu-left')
  api.selection.setLanguage('en')
  void syncToolbarSize()
})
document.addEventListener('click', (event) => {
  if (event.target.closest('#translate-group')) return
  closeMenu()
})

api.selection.onState((state) => {
  applyLanguage(state?.language === 'en' ? 'en' : 'zh')
  closeMenu()
})
applyLanguage('zh')
