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

const bar = document.querySelector('#bar')
const menu = document.querySelector('#language-menu')

/**
 * Ask the helper where everything goes and place it there.
 *
 * The helper owns the geometry: it knows the screen edges and which side of the selection the
 * bar was put on. The page only measures how big the two boxes want to be and then honours
 * the offsets it gets back. Laying the menu out with CSS instead is what left it outside the
 * window: an absolutely-positioned box that the stylesheet forgets to re-place does not follow
 * the flex row it appears to be in.
 */
async function syncToolbarLayout() {
  const barRect = bar.getBoundingClientRect()
  const menuRect = menu.hidden ? barRect : menu.getBoundingClientRect()
  // The union of both boxes: the helper turns this into a window plus two offsets.
  const layout = await api.selection.setContentSize({
    width: Math.max(1, Math.ceil(menu.hidden ? barRect.width : Math.max(barRect.width, menuRect.width))),
    height: Math.max(1, Math.ceil(barRect.height + (menu.hidden ? 0 : menuRect.height))),
  })
  const windowBox = layout?.window
  if (windowBox === undefined) return
  document.documentElement.style.setProperty('--window-w', `${String(windowBox.width)}px`)
  document.documentElement.style.setProperty('--window-h', `${String(windowBox.height)}px`)
  bar.style.left = `${String(layout.bar?.left ?? 0)}px`
  bar.style.top = `${String(layout.bar?.top ?? 0)}px`
  if (layout.menu === null || menu.hidden) {
    menu.style.removeProperty('left')
    menu.style.removeProperty('top')
    return
  }
  menu.style.left = `${String(layout.menu.left)}px`
  menu.style.top = `${String(layout.menu.top)}px`
}

function closeMenu() {
  if (menu.hidden) return
  menu.hidden = true
  void syncToolbarLayout()
}

document.querySelector('#language-zh').textContent = '中文'
document.querySelector('#language-en').textContent = 'English'

document.querySelector('#search').addEventListener('click', () => { api.selection.search() })
document.querySelector('#translate').addEventListener('click', () => { api.selection.translate() })
document.querySelector('#send-to-agent').addEventListener('click', () => { api.selection.sendToAgent() })
document.querySelector('#translate-arrow').addEventListener('click', (event) => {
  event.stopPropagation()
  menu.hidden = !menu.hidden
  void syncToolbarLayout()
})
document.querySelector('#language-zh').addEventListener('click', () => {
  menu.hidden = true
  api.selection.setLanguage('zh')
  void syncToolbarLayout()
})
document.querySelector('#language-en').addEventListener('click', () => {
  menu.hidden = true
  api.selection.setLanguage('en')
  void syncToolbarLayout()
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
