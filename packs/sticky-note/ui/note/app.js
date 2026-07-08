// Sticky Note: a jot pad that autosaves to per-widget storage. Pure UI, no host, no capabilities —
// storage is a widget's own isolated KV (ungated). The `accent` setting themes the paper.
const g = window.__garret
const pad = document.getElementById('pad')

let saveTimer = 0
pad.addEventListener('input', () => {
  if (!g?.storage) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void g.storage.set('text', pad.value), 250)
})

function applyAccent(accent) {
  document.body.className = accent && accent !== 'yellow' ? `accent-${accent}` : ''
}

async function load() {
  if (!g?.storage) return
  try {
    const [text, accent] = await Promise.all([g.storage.get('text'), g.storage.get('accent')])
    if (typeof text === 'string') pad.value = text
    applyAccent(typeof accent === 'string' ? accent : 'yellow')
  } catch {
    /* not bound yet */
  }
}

if (g) {
  g.onReady(() => void load())
  // Re-read the accent when the board regains focus (picks up a settings change without reload).
  g.onActiveChange((a) => a && void load())
} else {
  void load()
}
