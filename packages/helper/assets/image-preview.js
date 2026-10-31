const api = window.dshLasso?.preview
const backdrop = document.querySelector('#backdrop')
const image = document.querySelector('#image')
const hint = document.querySelector('#hint')

const HINTS = {
  zh: 'Esc 或点击背景关闭',
  en: 'Esc or click the backdrop to close',
}

function applyLabels(locale) {
  hint.textContent = HINTS[locale === 'en' ? 'en' : 'zh']
}

api?.onImage((payload) => {
  if (payload === null || typeof payload !== 'object') return
  if (typeof payload.src === 'string' && payload.src !== '') image.src = payload.src
  applyLabels(payload.locale)
})

api?.onAppearance((payload) => {
  if (payload !== null && typeof payload === 'object') applyLabels(payload.locale)
})

image.addEventListener('click', (event) => { event.stopPropagation() })
backdrop.addEventListener('click', () => api?.close())
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    api?.close()
  }
})
