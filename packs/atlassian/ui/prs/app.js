// Pull Requests — self-contained. Uses the pack's SHARED Atlassian account (email + API token). Open
// PRs are listed per CONFIGURED repo: Bitbucket API tokens can't hit user-scoped list endpoints
// (/2.0/user), only concrete repo endpoints — so the widget takes a `workspace/repo` list. Network via
// g.fetch, gated to network:api.bitbucket.org.
const g = window.__garret
const body = document.getElementById('body')
const refresh = document.getElementById('refresh')
const BASE = 'https://api.bitbucket.org/2.0'

function note(html, isErr) {
  body.innerHTML = `<div class="note${isErr ? ' err' : ''}">${html}</div>`
}

// "workspace/repo, ws/repo2" (also tolerates pasted bitbucket.org URLs), comma- or newline-separated.
function parseRepos(raw) {
  return String(raw || '')
    .split(/[\n,]/)
    .map((s) =>
      s
        .trim()
        .replace(/^https?:\/\/bitbucket\.org\//i, '')
        .replace(/\/(pull-requests|src|commits).*$/i, '')
        .replace(/\/+$/, '')
    )
    .filter((s) => /^[^/]+\/[^/]+$/.test(s))
}

async function config() {
  const email = ((await g.shared.storage.get('email')) || '').trim()
  const token = (await g.shared.secrets.get('token').catch(() => '')) || ''
  const repos = parseRepos(await g.storage.get('repos'))
  return { email, token, repos }
}

function render(prs) {
  if (!prs.length) return note('No open pull requests. 🎉')
  body.innerHTML = ''
  for (const pr of prs) {
    const row = document.createElement('div')
    row.className = 'row'
    row.style.flexDirection = 'column'
    row.style.gap = '2px'
    row.style.alignItems = 'stretch'
    const t = document.createElement('span')
    t.className = 'sum'
    t.textContent = pr.title || '(untitled)'
    const meta = document.createElement('span')
    meta.className = 'tag'
    meta.textContent = [pr.repo, pr.author].filter(Boolean).join(' · ')
    row.append(t, meta)
    body.appendChild(row)
  }
}

async function fetchRepoPRs(ref, headers) {
  const url =
    `${BASE}/repositories/${encodeURIComponent(ref.split('/')[0])}/${encodeURIComponent(ref.split('/')[1])}` +
    '/pullrequests?state=OPEN&pagelen=30&fields=values.title,values.author.display_name,values.source.branch.name'
  const res = await g.fetch(url, { headers })
  if (!res.ok) throw new Error(`${ref}: ${res.status}`)
  const data = await res.json()
  return (data.values || []).map((p) => ({
    title: p.title,
    author: p.author && p.author.display_name,
    repo: ref
  }))
}

async function load() {
  if (!g) return
  const { email, token, repos } = await config()
  if (!email || !token) {
    return note('Add your <b>Atlassian account</b> (email + API token) in Settings → Atlassian.')
  }
  if (!repos.length) {
    return note('Add one or more <b>repositories</b> (<code>workspace/repo</code>) in this widget\'s settings.')
  }
  note('Loading…')
  const headers = { Authorization: 'Basic ' + btoa(`${email}:${token}`), Accept: 'application/json' }
  try {
    const groups = await Promise.all(
      repos.map((ref) => fetchRepoPRs(ref, headers).catch((e) => ({ error: e.message })))
    )
    const prs = []
    const errors = []
    for (const grp of groups) {
      if (Array.isArray(grp)) prs.push(...grp)
      else if (grp && grp.error) errors.push(grp.error)
    }
    if (!prs.length && errors.length) return note(`Could not load: ${errors.join('; ')}`, true)
    render(prs)
  } catch (e) {
    note(`Could not reach Bitbucket: ${(e && e.message) || e}`, true)
  }
}

refresh.addEventListener('click', () => void load())
if (g) {
  g.onReady(() => void load())
  g.onActiveChange((a) => a && void load())
  setInterval(() => g.active && void load(), 120000)
}
