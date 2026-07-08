// Pull Requests — cloned from the built-in widget, new architecture. Account (email + Bitbucket token,
// + Jira token/site for the "me" filters) lives in the pack's SHARED store; per-placement filters live
// ON the widget (⚙, g.instanceStorage). PRs are listed per configured repo (Bitbucket API tokens can't
// hit user-scoped list endpoints). Network via g.fetch (api.bitbucket.org + *.atlassian.net for /myself).
const g = window.__garret
const titleEl = document.getElementById('title')
const gearBtn = document.getElementById('gear')
const refreshBtn = document.getElementById('refresh')
const configEl = document.getElementById('config')
const body = document.getElementById('body')
const BB = 'https://api.bitbucket.org/2.0'

const DEFAULTS = {
  title: '', repos: '', state: 'OPEN', author: 'anyone', authorName: '', reviewer: 'anyone', reviewState: 'any', refreshMin: '5', muted: []
}
let cfg = { ...DEFAULTS }
const STATE_CLASS = { OPEN: 'open', MERGED: 'merged', DECLINED: 'declined' }

function note(html, isErr) {
  body.innerHTML = `<div class="note${isErr ? ' err' : ''}">${html}</div>`
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
  const [email, site] = await Promise.all([g.shared.storage.get('email'), g.shared.storage.get('jiraSite')])
  const [bbToken, jiraToken] = await Promise.all([
    g.shared.secrets.get('bitbucketToken').catch(() => ''),
    g.shared.secrets.get('jiraToken').catch(() => '')
  ])
  return { email: (email || '').trim(), site: normalizeSite(site), bbToken: bbToken || '', jiraToken: jiraToken || '' }
}

/* ---- inline config ---- */
function cfgRow(label, control) {
  const row = document.createElement('div')
  row.className = 'cfg-row'
  const l = document.createElement('label')
  l.textContent = label
  row.append(l, control)
  return row
}
function input(key, ph) {
  const el = document.createElement('input')
  el.placeholder = ph || ''
  el.value = cfg[key] == null ? '' : String(cfg[key])
  el.addEventListener('change', () => set(key, el.value))
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
function renderConfig() {
  configEl.innerHTML = ''
  configEl.append(
    cfgRow('Title', input('title', 'optional')),
    cfgRow('Repos', input('repos', 'workspace/repo, workspace/repo2')),
    cfgRow('State', select('state', [['OPEN', 'Open'], ['MERGED', 'Merged'], ['DECLINED', 'Declined'], ['ALL', 'All']])),
    cfgRow('Author', select('author', [['anyone', 'Anyone'], ['me', 'Me'], ['name', 'Someone']]))
  )
  if (cfg.author === 'name') configEl.append(cfgRow('Author name', input('authorName', 'display name')))
  configEl.append(
    cfgRow('Reviewer', select('reviewer', [['anyone', 'Anyone'], ['me', 'Me']])),
    cfgRow('My review', select('reviewState', [['any', 'Any'], ['pending', 'Needs my review'], ['approved', 'Approved'], ['changes_requested', 'Changes requested']])),
    cfgRow('Refresh', select('refreshMin', [['0', 'Manual'], ['5', '5 min'], ['15', '15 min'], ['30', '30 min']]))
  )
}
function set(key, val) {
  cfg[key] = val
  void g.instanceStorage.set(key, val)
  if (key === 'title') titleEl.textContent = val || 'Pull Requests'
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

/* ---- self account id (for me filters), via Jira /myself ---- */
async function selfAccountId(email, site, jiraToken) {
  if (!site || !jiraToken) return null
  try {
    const res = await g.fetch(`${site}/rest/api/3/myself`, {
      headers: { Authorization: 'Basic ' + btoa(`${email}:${jiraToken}`), Accept: 'application/json' }
    })
    if (!res.ok) return null
    return (await res.json()).accountId || null
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
  if (!res.ok) throw new Error(`${ref}: ${res.status}`)
  return ((await res.json()).values || []).map((p) => ({ ...p, repo: ref }))
}

function passesFilter(p, me) {
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
  body.innerHTML = ''
  const muted = cfg.muted || []
  const shown = prs.filter((p) => !muted.includes(p.id))
  if (!shown.length) return note('No matching pull requests.')
  let lastRepo = ''
  for (const p of shown) {
    if (p.repo !== lastRepo) {
      lastRepo = p.repo
      const h = document.createElement('div')
      h.className = 'repo-group'
      h.textContent = p.repo
      body.appendChild(h)
    }
    const btn = document.createElement('button')
    btn.className = 'item pr'
    const sum = document.createElement('span')
    sum.className = 'sum'
    sum.textContent = p.title || '(untitled)'
    const mute = document.createElement('span')
    mute.className = 'mute'
    mute.textContent = '×'
    mute.title = 'Mute'
    mute.addEventListener('click', (e) => {
      e.stopPropagation()
      set('muted', [...(cfg.muted || []), p.id])
      render(prs)
    })
    const head = document.createElement('div')
    head.style.display = 'flex'
    head.style.alignItems = 'baseline'
    head.style.gap = '8px'
    head.append(sum, mute)

    const meta = document.createElement('div')
    meta.className = 'pr-meta'
    if (p.author?.display_name) {
      const a = document.createElement('span')
      a.textContent = p.author.display_name
      meta.appendChild(a)
    }
    const reviewers = (p.participants || []).filter((x) => x.role === 'REVIEWER')
    if (reviewers.length) {
      const revs = document.createElement('span')
      revs.className = 'revs'
      reviewers.slice(0, 5).forEach((r) => {
        const d = document.createElement('span')
        d.className = `dot ${mapReview(r.state)}`
        d.title = `${r.user?.display_name || ''} · ${mapReview(r.state)}`
        revs.appendChild(d)
      })
      meta.appendChild(revs)
    }
    const pill = document.createElement('span')
    pill.className = `pill ${STATE_CLASS[p.state] || 'open'}`
    pill.textContent = p.state
    pill.style.marginLeft = 'auto'
    meta.appendChild(pill)

    btn.append(head, meta)
    const href = p.links?.html?.href
    if (href) btn.addEventListener('click', () => g.openExternal(href))
    body.appendChild(btn)
  }
  if (muted.length) {
    const un = document.createElement('button')
    un.className = 'unmute'
    un.textContent = `${muted.length} muted · Unmute all`
    un.addEventListener('click', () => {
      set('muted', [])
      void load()
    })
    body.appendChild(un)
  }
}

async function load() {
  if (!g) return
  const { email, site, bbToken, jiraToken } = await account()
  const repos = parseRepos(cfg.repos)
  if (!email || !bbToken) return note('Add your <b>Atlassian account</b> (email + Bitbucket token) in Settings → Atlassian.')
  if (!repos.length) return note('Add one or more <b>repos</b> (<code>workspace/repo</code>) in ⚙.')
  note('Loading…')
  const headers = { Authorization: 'Basic ' + btoa(`${email}:${bbToken}`), Accept: 'application/json' }
  const needMe = cfg.author === 'me' || cfg.reviewer === 'me'
  const me = needMe ? await selfAccountId(email, site, jiraToken) : null
  if (needMe && !me) return note('The "Me" filter needs your Jira token + site (used to resolve your account).', true)
  try {
    const groups = await Promise.all(repos.map((ref) => fetchRepoPRs(ref, headers, cfg.state).catch((e) => ({ error: e.message }))))
    const prs = []
    const errors = []
    for (const grp of groups) {
      if (Array.isArray(grp)) prs.push(...grp.filter((p) => passesFilter(p, me)))
      else if (grp && grp.error) errors.push(grp.error)
    }
    if (!prs.length && errors.length) return note(`Could not load: ${errors.join('; ')}`, true)
    render(prs)
  } catch (e) {
    note(`Could not reach Bitbucket: ${(e && e.message) || e}`, true)
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
  titleEl.textContent = cfg.title || 'Pull Requests'
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
