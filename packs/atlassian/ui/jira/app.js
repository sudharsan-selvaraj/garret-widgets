// Jira Tickets — self-contained: the Atlassian account (email/token/site) lives in the pack's SHARED
// store (entered once in Settings → Atlassian → Account); the per-widget JQL is optional. All network
// via g.fetch, gated to network:*.atlassian.net. No host service.
const g = window.__garret
const body = document.getElementById('body')
const refresh = document.getElementById('refresh')

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

function note(html, isErr) {
  body.innerHTML = `<div class="note${isErr ? ' err' : ''}">${html}</div>`
}
function normalizeSite(s) {
  s = String(s || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  return /^https?:\/\//i.test(s) ? s : `https://${s}`
}

async function config() {
  const [email, site, jql] = await Promise.all([
    g.shared.storage.get('email'),
    g.shared.storage.get('jiraSite'),
    g.storage.get('jql')
  ])
  const token = await g.shared.secrets.get('token').catch(() => '')
  return { email: (email || '').trim(), site: normalizeSite(site), token: token || '', jql: (jql || '').trim() }
}

function render(issues) {
  if (!issues.length) return note('No open issues. 🎉')
  body.innerHTML = ''
  for (const it of issues) {
    const f = it.fields || {}
    const row = document.createElement('div')
    row.className = 'row'
    const key = document.createElement('span')
    key.className = 'key'
    key.textContent = it.key
    const sum = document.createElement('span')
    sum.className = 'sum'
    sum.textContent = f.summary || ''
    const st = document.createElement('span')
    st.className = 'tag'
    st.textContent = (f.status && f.status.name) || ''
    row.append(key, sum, st)
    body.appendChild(row)
  }
}

async function load() {
  if (!g) return
  const { email, site, token, jql } = await config()
  if (!site || !email || !token) {
    return note('Add your <b>Atlassian account</b> (email, API token, Jira site) in Settings → Atlassian. Create a token at <b>id.atlassian.com</b>.')
  }
  note('Loading…')
  try {
    const res = await g.fetch(`${site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${email}:${token}`),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jql: jql || DEFAULT_JQL, maxResults: 25, fields: ['summary', 'status', 'priority'] })
    })
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' — check email + API token' : ''
      return note(`Jira request failed (${res.status})${hint}.`, true)
    }
    render((await res.json()).issues || [])
  } catch (e) {
    note(`Could not reach Jira: ${(e && e.message) || e}`, true)
  }
}

refresh.addEventListener('click', () => void load())
if (g) {
  g.onReady(() => void load())
  g.onActiveChange((a) => a && void load())
  setInterval(() => g.active && void load(), 120000)
}
