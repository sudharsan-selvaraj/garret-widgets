// Jira Tickets — native Garret look via the shared ~theme.css classes. Account (email/Jira token/site)
// in the pack's SHARED store; per-placement filters ON the widget (⚙, g.instanceStorage). Data via
// g.fetch (network:*.atlassian.net). No host service.
const g = window.__garret
const titleEl = document.getElementById('title')
const gearBtn = document.getElementById('gear')
const refreshBtn = document.getElementById('refresh')
const configEl = document.getElementById('config')
const body = document.getElementById('body')

const DEFAULTS = { title: '', project: '', onlyMine: true, statuses: '', sprint: 'any', jql: '', maxResults: 15, refreshMin: '5' }
let cfg = { ...DEFAULTS }
const CAT_CLASS = { 'To Do': 'todo', 'In Progress': 'progress', Done: 'done' }
let site = ''

function empty(html) {
  body.innerHTML = `<div class="svc-empty">${html}</div>`
}
function fail(msg) {
  body.innerHTML = `<div class="svc-error">${msg}</div>`
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
  const [email, s] = await Promise.all([g.shared.storage.get('email'), g.shared.storage.get('jiraSite')])
  const token = await g.shared.secrets.get('jiraToken').catch(() => '')
  return { email: (email || '').trim(), site: normalizeSite(s), token: token || '' }
}

/* ---- config form (native .settings-form) ---- */
function row(label, control) {
  const r = document.createElement('div')
  r.className = 'settings-row'
  const l = document.createElement('label')
  l.className = 'settings-row-label'
  l.textContent = label
  const c = document.createElement('div')
  c.className = 'settings-row-control'
  c.appendChild(control)
  r.append(l, c)
  return r
}
function group(...rows) {
  const gEl = document.createElement('div')
  gEl.className = 'settings-group'
  rows.forEach((r) => gEl.appendChild(r))
  const item = document.createElement('div')
  item.className = 'settings-item'
  item.appendChild(gEl)
  return item
}
function inp(key, ph, type) {
  const el = document.createElement('input')
  el.className = 'row-input'
  el.type = type || 'text'
  el.placeholder = ph || ''
  el.value = cfg[key] == null ? '' : String(cfg[key])
  el.addEventListener('change', () => set(key, type === 'number' ? Number(el.value) || 0 : el.value))
  return el
}
function sel(key, opts) {
  const el = document.createElement('select')
  el.className = 'row-select'
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
  el.innerHTML = '<span class="switch-knob"></span>'
  el.addEventListener('click', () => {
    set(key, !cfg[key])
    el.className = `switch${cfg[key] ? ' on' : ''}`
  })
  return el
}
function renderConfig() {
  configEl.innerHTML = ''
  configEl.append(
    group(
      row('Title', inp('title', 'optional')),
      row('Project key', inp('project', 'e.g. OCA')),
      row('Only mine', toggle('onlyMine')),
      row('Statuses', inp('statuses', 'In Progress, In Review')),
      row('Sprint', sel('sprint', [['any', 'Any'], ['open', 'Active sprint']])),
      row('Max results', inp('maxResults', '', 'number')),
      row('Refresh', sel('refreshMin', [['0', 'Manual'], ['1', '1 min'], ['5', '5 min'], ['15', '15 min']]))
    ),
    group(row('JQL', inp('jql', 'advanced — overrides the above')))
  )
}
function set(key, val) {
  cfg[key] = val
  void g.instanceStorage.set(key, val)
  if (key === 'title') titleEl.textContent = val || 'Jira Tickets'
  scheduleReload()
}

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
  if (!issues.length) return empty('No matching tickets.')
  const list = document.createElement('div')
  list.className = 'ticket-list'
  for (const it of issues) {
    const f = it.fields || {}
    const cat = (f.status && f.status.statusCategory && f.status.statusCategory.name) || 'To Do'
    const btn = document.createElement('button')
    btn.className = 'ticket'
    btn.innerHTML =
      `<span class="ticket-dot ${CAT_CLASS[cat] || 'todo'}"></span>` +
      `<span class="ticket-key"></span><span class="ticket-summary"></span>` +
      `<span class="status-pill ${CAT_CLASS[cat] || 'todo'}"></span>`
    btn.querySelector('.ticket-key').textContent = it.key
    btn.querySelector('.ticket-summary').textContent = f.summary || ''
    btn.querySelector('.status-pill').textContent = (f.status && f.status.name) || 'Unknown'
    btn.addEventListener('click', () => site && g.openExternal(`${site}/browse/${it.key}`))
    list.appendChild(btn)
  }
  body.innerHTML = ''
  body.appendChild(list)
}

async function load() {
  if (!g) return
  const acc = await account()
  site = acc.site
  if (!acc.site || !acc.email || !acc.token) {
    return empty('Add your <b>Atlassian account</b> (email, Jira token, site) in Settings → Atlassian.')
  }
  empty('Loading…')
  try {
    const res = await g.fetch(`${acc.site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${acc.email}:${acc.token}`), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql: buildJql(cfg), maxResults: Number(cfg.maxResults) || 15, fields: ['summary', 'status', 'priority'] })
    })
    if (!res.ok) {
      const s = res.status || res.statusText || 'request failed'
      return fail(s === 401 || s === 403 ? 'Jira auth failed — check email + Jira token.' : `Jira request failed (${s}).`)
    }
    render((await res.json()).issues || [])
  } catch (e) {
    fail(`Could not reach Jira: ${(e && e.message) || e}`)
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
