/** Browser-side bridge to the vendored shiki bundle: upgrades rendered code
 * blocks in place, lazily loads grammars, and re-upgrades when one lands. */

const tracked = new Set()

let loading
let vendor

async function vendorModule() {
  loading ??= import('./vendor/shiki.js').then((module) => {
    vendor = module
    module.subscribeGrammarLoaded(() => {
      for (const ref of tracked) {
        const root = ref.deref()
        if (root) void upgradeCodeBlocks(root, { track: false })
      }
    })
    return module
  }, () => {
    // The bundle failed to load; code blocks stay plain.
    loading = undefined
    return undefined
  })
  return loading
}

/** Replace plain code-block bodies with shiki HTML where a grammar is ready. */
export async function upgradeCodeBlocks(root, { track = true } = {}) {
  if (root === null || typeof root.querySelectorAll !== 'function') return
  if (track) tracked.add(new WeakRef(root))
  const module = await vendorModule()
  if (module === undefined) return
  for (const block of root.querySelectorAll('.cb[data-code-lang]')) {
    const pre = block.querySelector('pre.cb-plain')
    if (pre === null) continue
    const html = module.highlightToHtml(pre.textContent ?? '', block.dataset.codeLang)
    if (html === undefined || !pre.isConnected) continue
    const template = document.createElement('template')
    template.innerHTML = html
    const next = template.content.firstElementChild
    if (next !== null) pre.replaceWith(next)
  }
}

function sweep() {
  for (const reference of tracked) {
    if (reference.deref() === undefined) tracked.delete(reference)
  }
}

setInterval(sweep, 30_000)
