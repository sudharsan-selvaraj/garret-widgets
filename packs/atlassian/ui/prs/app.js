// Pull Requests — native Garret look via the shared ~theme.css. Account (email + Bitbucket token, +
// Jira token/site for "me" filters) in the pack's SHARED store; per-placement filters in
// g.instanceStorage, edited in a config panel opened from the frame's ⋯ → Settings (g.onOpenSettings).
// PRs listed per configured repo (Bitbucket API tokens can't hit user-scoped list endpoints).
const g = window.__garret
const configEl = document.getElementById('config')
const body = document.getElementById('body')
const BB = 'https://api.bitbucket.org/2.0'

const DEFAULTS = { repos: '', state: 'OPEN', author: 'anyone', authorName: '', reviewer: 'anyone', reviewState: 'any', refreshMin: '5', muted: [] }
let cfg = { ...DEFAULTS }
const STATE_CLASS = { OPEN: 'open', MERGED: 'merged', DECLINED: 'declined' }

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
function parseRepos(raw) {
  return String(raw || '')
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^https?:\/\/bitbucket\.org\//i, '').replace(/\/(pull-requests|src|commits).*$/i, '').replace(/\/+$/, ''))
    .filter((s) => /^[^/]+\/[^/]+$/.test(s))
}
function mapReview(s) {
  return s === 'approved' ? 'approved' : s === 'changes_requested' ? 'changes_requested' : 'pending'
}
async function account() {
  const [email, s] = await Promise.all([g.shared.storage.get('email'), g.shared.storage.get('jiraSite')])
  const [bbToken, jiraToken] = await Promise.all([
    g.shared.secrets.get('bitbucketToken').catch(() => ''),
    g.shared.secrets.get('jiraToken').catch(() => '')
  ])
  return { email: (email || '').trim(), site: normalizeSite(s), bbToken: bbToken || '', jiraToken: jiraToken || '' }
}

/* ---- config panel (native .settings-form), shown from the frame's ⋯ → Settings ---- */
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
function group(rows) {
  const gEl = document.createElement('div')
  gEl.className = 'settings-group'
  rows.forEach((r) => gEl.appendChild(r))
  const item = document.createElement('div')
  item.className = 'settings-item'
  item.appendChild(gEl)
  return item
}
function inp(key, ph) {
  const el = document.createElement('input')
  el.className = 'row-input'
  el.placeholder = ph || ''
  el.value = cfg[key] == null ? '' : String(cfg[key])
  el.addEventListener('change', () => set(key, el.value))
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
function renderConfig() {
  configEl.innerHTML = ''
  const rows = [
    row('Repos', inp('repos', 'workspace/repo, workspace/repo2')),
    row('State', sel('state', [['OPEN', 'Open'], ['MERGED', 'Merged'], ['DECLINED', 'Declined'], ['ALL', 'All']])),
    row('Author', sel('author', [['anyone', 'Anyone'], ['me', 'Me'], ['name', 'Someone']]))
  ]
  if (cfg.author === 'name') rows.push(row('Author name', inp('authorName', 'display name')))
  rows.push(
    row('Reviewer', sel('reviewer', [['anyone', 'Anyone'], ['me', 'Me']])),
    row('My review', sel('reviewState', [['any', 'Any'], ['pending', 'Needs my review'], ['approved', 'Approved'], ['changes_requested', 'Changes requested']])),
    row('Refresh', sel('refreshMin', [['0', 'Manual'], ['5', '5 min'], ['15', '15 min'], ['30', '30 min']]))
  )
  configEl.appendChild(group(rows))
  const footer = document.createElement('div')
  footer.className = 'settings-footer'
  const saved = document.createElement('span')
  saved.className = 'settings-saved'
  saved.textContent = 'Changes save automatically'
  const done = document.createElement('button')
  done.className = 'settings-done'
  done.textContent = 'Done'
  done.addEventListener('click', closeConfig)
  footer.append(saved, done)
  configEl.appendChild(footer)
}
function openConfig() {
  renderConfig()
  configEl.hidden = false
  body.style.display = 'none'
}
function closeConfig() {
  configEl.hidden = true
  body.style.display = ''
}
function set(key, val) {
  cfg[key] = val
  void g.instanceStorage.set(key, val)
  if (key === 'author') renderConfig()
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

async function selfAccountId(email, site, jiraToken) {
  if (!site || !jiraToken) return null
  try {
    const res = await g.fetch(`${site}/rest/api/3/myself`, {
      headers: { Authorization: 'Basic ' + btoa(`${email}:${jiraToken}`), Accept: 'application/json' }
    })
    return res.ok ? (await res.json()).accountId || null : null
  } catch {
    return null
  }
}
async function fetchRepoPRs(ref, headers, state) {
  const [ws, repo] = ref.split('/')
  const stateQ = state === 'ALL' ? '' : `state=${encodeURIComponent(state)}&`
  const url =
    `${BB}/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(repo)}/pullrequests?${stateQ}pagelen=30` +
    '&fields=values.id,values.title,values.state,values.author.display_name,values.author.account_id,values.comment_count,values.links.html.href,values.participants.role,values.participants.state,values.participants.user.account_id,values.participants.user.display_name'
  const res = await g.fetch(url, { headers })
  if (!res.ok) {
    let detail = ''
    try {
      const t = await res.text()
      detail = JSON.parse(t)?.error?.message || ''
    } catch {
      /* no body */
    }
    throw new Error(`${ref}: ${res.status || res.statusText || 'no status'}${detail ? ' — ' + detail : ''}`)
  }
  return ((await res.json()).values || []).map((p) => ({ ...p, repo: ref }))
}
function passes(p, me) {
  if (cfg.author === 'me' && p.author?.account_id !== me) return false
  if (cfg.author === 'name' && cfg.authorName.trim() && !(p.author?.display_name || '').toLowerCase().includes(cfg.authorName.trim().toLowerCase())) return false
  if (cfg.reviewer === 'me') {
    const mine = (p.participants || []).find((x) => x.user?.account_id === me && x.role === 'REVIEWER')
    if (!mine) return false
    if (cfg.reviewState !== 'any' && mapReview(mine.state) !== cfg.reviewState) return false
  }
  return true
}

function render(prs) {
  const muted = cfg.muted || []
  const shown = prs.filter((p) => !muted.includes(p.id))
  if (!shown.length) return empty(muted.length ? 'No matching pull requests.' : 'No open pull requests.')
  const wrap = document.createElement('div')
  wrap.className = 'pr-widget'
  const byRepo = {}
  for (const p of shown) (byRepo[p.repo] = byRepo[p.repo] || []).push(p)
  for (const repo of Object.keys(byRepo)) {
    const head = document.createElement('div')
    head.className = 'pr-group-head'
    head.innerHTML = `<span class="pr-group-name"></span><span class="pr-group-count"></span>`
    head.querySelector('.pr-group-name').textContent = repo
    head.querySelector('.pr-group-count').textContent = String(byRepo[repo].length)
    wrap.appendChild(head)
    for (const p of byRepo[repo]) {
      const rowEl = document.createElement('div')
      rowEl.className = 'pr-row'
      const title = document.createElement('div')
      title.className = 'pr-row-title'
      title.textContent = p.title || '(untitled)'
      const meta = document.createElement('div')
      meta.className = 'pr-meta'
      if (p.author?.display_name) {
        const a = document.createElement('span')
        a.className = 'pr-author'
        a.textContent = p.author.display_name
        meta.appendChild(a)
      }
      const reviewers = (p.participants || []).filter((x) => x.role === 'REVIEWER')
      if (reviewers.length) {
        const revs = document.createElement('span')
        revs.className = 'pr-reviewers'
        reviewers.slice(0, 5).forEach((r) => {
          const d = document.createElement('span')
          d.className = `pr-rev-dot ${mapReview(r.state)}`
          d.title = `${r.user?.display_name || ''} · ${mapReview(r.state)}`
          revs.appendChild(d)
        })
        meta.appendChild(revs)
      }
      if (p.comment_count) {
        const c = document.createElement('span')
        c.className = 'pr-comments'
        c.textContent = `💬 ${p.comment_count}`
        meta.appendChild(c)
      }
      const pill = document.createElement('span')
      pill.className = `status-pill ${STATE_CLASS[p.state] || 'open'}`
      pill.textContent = p.state
      pill.style.marginLeft = 'auto'
      meta.appendChild(pill)
      rowEl.append(title, meta)
      const href = p.links?.html?.href
      if (href) rowEl.addEventListener('click', () => g.openExternal(href))
      rowEl.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        set('muted', [...(cfg.muted || []), p.id])
        render(prs)
      })
      wrap.appendChild(rowEl)
    }
  }
  if (muted.length) {
    const un = document.createElement('button')
    un.className = 'pr-unmute'
    un.textContent = `${muted.length} muted · Unmute all`
    un.addEventListener('click', () => {
      set('muted', [])
      void load()
    })
    wrap.appendChild(un)
  }
  body.innerHTML = ''
  body.appendChild(wrap)
}

async function load() {
  if (!g) return
  const acc = await account()
  const repos = parseRepos(cfg.repos)
  if (!acc.email || !acc.bbToken) return empty('Add your <b>Atlassian account</b> (email + Bitbucket token) in Settings → Atlassian.')
  if (!repos.length) return empty('Add one or more <b>repos</b> (<code>workspace/repo</code>) in ⋯ → Settings.')
  empty('Loading…')
  const headers = { Authorization: 'Basic ' + btoa(`${acc.email}:${acc.bbToken}`), Accept: 'application/json' }
  const needMe = cfg.author === 'me' || cfg.reviewer === 'me'
  const me = needMe ? await selfAccountId(acc.email, acc.site, acc.jiraToken) : null
  if (needMe && !me) return fail('The "Me" filter needs your Jira token + site (used to resolve your account).')
  try {
    const groups = await Promise.all(repos.map((ref) => fetchRepoPRs(ref, headers, cfg.state).catch((e) => ({ error: e.message }))))
    const prs = []
    const errors = []
    for (const grp of groups) {
      if (Array.isArray(grp)) prs.push(...grp.filter((p) => passes(p, me)))
      else if (grp && grp.error) errors.push(grp.error)
    }
    if (!prs.length && errors.length) {
      const auth = errors.some((e) => /\b(401|403)\b/.test(e))
      return fail(auth ? 'Bitbucket auth failed — the token needs Bitbucket read access (a separate Bitbucket API token / app password, not the Jira one).' : `Could not load: ${errors.join('; ')}`)
    }
    render(prs)
  } catch (e) {
    fail(`Could not reach Bitbucket: ${(e && e.message) || e}`)
  }
}

async function init() {
  if (g && g.instanceStorage) {
    const saved = {}
    await Promise.all(Object.keys(DEFAULTS).map(async (k) => {
      const v = await g.instanceStorage.get(k)
      if (v !== undefined) saved[k] = v
    }))
    cfg = { ...DEFAULTS, ...saved }
  }
  reschedulePoll()
  await load()
}

if (g) {
  g.onReady(() => void init())
  g.onActiveChange((a) => a && void load())
  g.onOpenSettings(() => (configEl.hidden ? openConfig() : closeConfig()))
} else {
  void init()
}
