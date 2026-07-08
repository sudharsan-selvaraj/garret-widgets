// Jira Tickets — cloned from the built-in widget, new architecture: the Atlassian account (email +
// Jira token + site) is the pack's SHARED store (Settings → Atlassian → Account); the per-placement
// filters live ON the widget (⚙, stored in g.instanceStorage). Data via g.fetch (network:*.atlassian.net).
const g = window.__garret
const titleEl = document.getElementById('title')
const gearBtn = document.getElementById('gear')
const refreshBtn = document.getElementById('refresh')
const configEl = document.getElementById('config')
const body = document.getElementById('body')

const DEFAULTS = { title: '', project: '', onlyMine: true, statuses: '', sprint: 'any', jql: '', maxResults: 15, refreshMin: '5' }
let cfg = { ...DEFAULTS }
const CAT_CLASS = { 'To Do': 'todo', 'In Progress': 'progress', Done: 'done' }

function note(html, isErr) {
  body.innerHTML = `<div class="note${isErr ? ' err' : ''}">${html}</div>`
}
function normalizeSite(s) {
  s = String(s || '').trim().replace(/\/+$/, '')
  return s && !/^https?:\/\//i.test(s) ? `https://${s}` : s
}
function buildJql(c) {
  if (c.jql && c.jql.trim()) return c.jql.trim()
  const parts = []
  if (c.project && c.project.trim()) parts.push(`project = "${c.project.trim()}"`)
  if (c.onlyMine) parts.push('assignee = currentUser()')
  const statuses = (c.statuses || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (statuses.length) parts.push(`status in (${statuses.map((s) => `"${s}"`).join(', ')})`)
  if (c.sprint === 'open') parts.push('sprint in openSprints()')
  return `${parts.length ? parts.join(' AND ') + ' ' : ''}ORDER BY created DESC`
}

async function account() {
  const [email, site] = await Promise.all([g.shared.storage.get('email'), g.shared.storage.get('jiraSite')])
  const token = await g.shared.secrets.get('jiraToken').catch(() => '')
  return { email: (email || '').trim(), site: normalizeSite(site), token: token || '' }
}

/* ---- inline config panel ---- */
function cfgRow(label, control) {
  const row = document.createElement('div')
  row.className = 'cfg-row'
  const l = document.createElement('label')
  l.textContent = label
  row.append(l, control)
  return row
}
function input(key, ph, type) {
  const el = document.createElement('input')
  el.type = type || 'text'
  el.placeholder = ph || ''
  el.value = cfg[key] == null ? '' : String(cfg[key])
  el.addEventListener('change', () => set(key, type === 'number' ? Number(el.value) || 0 : el.value))
  return el
}
function select(key, opts) {
  const el = document.createElement('select')
  for (const [v, label] of opts) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    if (String(cfg[key]) === v) o.selected = true
    el.appendChild(o)
  }
  el.addEventListener('change', () => set(key, el.value))
  return el
}
function toggle(key) {
  const el = document.createElement('button')
  el.className = `switch${cfg[key] ? ' on' : ''}`
  el.innerHTML = '<span class="knob"></span>'
  el.addEventListener('click', () => {
    set(key, !cfg[key])
    el.className = `switch${cfg[key] ? ' on' : ''}`
  })
  return el
}
function renderConfig() {
  configEl.innerHTML = ''
  configEl.append(
    cfgRow('Title', input('title', 'optional')),
    cfgRow('Project key', input('project', 'e.g. OCA')),
    cfgRow('Only mine', toggle('onlyMine')),
    cfgRow('Statuses', input('statuses', 'In Progress, In Review')),
    cfgRow('Sprint', select('sprint', [['any', 'Any'], ['open', 'Active sprint']])),
    cfgRow('Max results', input('maxResults', '', 'number')),
    cfgRow('Refresh', select('refreshMin', [['0', 'Manual'], ['1', '1 min'], ['5', '5 min'], ['15', '15 min']])),
    cfgRow('JQL', input('jql', 'advanced — overrides the above'))
  )
}
function set(key, val) {
  cfg[key] = val
  void g.instanceStorage.set(key, val)
  if (key === 'title') titleEl.textContent = val || 'Jira Tickets'
  scheduleReload()
}

/* ---- data ---- */
let reloadTimer = 0
function scheduleReload() {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => void load(), 400)
}
let pollTimer = 0
function reschedulePoll() {
  clearInterval(pollTimer)
  const m = Number(cfg.refreshMin)
  if (m > 0) pollTimer = setInterval(() => g.active && void load(), m * 60000)
}

function render(issues) {
  body.innerHTML = ''
  if (!issues.length) return note('No matching tickets.')
  for (const it of issues) {
    const f = it.fields || {}
    const btn = document.createElement('button')
    btn.className = 'item'
    const cat = (f.status && f.status.statusCategory && f.status.statusCategory.name) || 'To Do'
    btn.innerHTML = `<span class="key"></span><span class="sum"></span><span class="pill ${CAT_CLASS[cat] || 'todo'}"></span>`
    btn.querySelector('.key').textContent = it.key
    btn.querySelector('.sum').textContent = f.summary || ''
    btn.querySelector('.pill').textContent = (f.status && f.status.name) || 'Unknown'
    if (cfg._site) btn.addEventListener('click', () => g.openExternal(`${cfg._site}/browse/${it.key}`))
    body.appendChild(btn)
  }
}

async function load() {
  if (!g) return
  const { email, site, token } = await account()
  cfg._site = site
  if (!site || !email || !token) {
    return note('Add your <b>Atlassian account</b> (email, Jira token, site) in Settings → Atlassian.')
  }
  note('Loading…')
  try {
    const res = await g.fetch(`${site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${email}:${token}`), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql: buildJql(cfg), maxResults: Number(cfg.maxResults) || 15, fields: ['summary', 'status', 'priority'] })
    })
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' — check email + Jira token' : ''
      return note(`Jira request failed (${res.status})${hint}.`, true)
    }
    render((await res.json()).issues || [])
  } catch (e) {
    note(`Could not reach Jira: ${(e && e.message) || e}`, true)
  }
}

gearBtn.addEventListener('click', () => {
  configEl.hidden = !configEl.hidden
  gearBtn.classList.toggle('on', !configEl.hidden)
})
refreshBtn.addEventListener('click', () => void load())

async function init() {
  if (g && g.instanceStorage) {
    const saved = {}
    await Promise.all(Object.keys(DEFAULTS).map(async (k) => {
      const v = await g.instanceStorage.get(k)
      if (v !== undefined) saved[k] = v
    }))
    cfg = { ...DEFAULTS, ...saved }
  }
  titleEl.textContent = cfg.title || 'Jira Tickets'
  renderConfig()
  reschedulePoll()
  await load()
}

if (g) {
  g.onReady(() => void init())
  g.onActiveChange((a) => a && void load())
} else {
  void init()
}
