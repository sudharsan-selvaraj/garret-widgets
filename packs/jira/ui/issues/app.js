// Jira: lists your open issues. Pure UI — auth is the user's own Atlassian API token (basic auth),
// read from the encrypted secrets store; site/email/jql from settings. All network via g.fetch,
// gated to network:*.atlassian.net.
const g = window.__garret
const body = document.getElementById('body')
const refresh = document.getElementById('refresh')

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

function note(html, isErr) {
  body.innerHTML = `<div class="note${isErr ? ' err' : ''}">${html}</div>`
}

async function config() {
  const [site, email, jql] = await Promise.all([
    g.storage.get('site'),
    g.storage.get('email'),
    g.storage.get('jql')
  ])
  const token = await g.secrets.get('token').catch(() => undefined)
  return { site: (site || '').trim(), email: (email || '').trim(), token: token || '', jql: (jql || '').trim() }
}

function render(issues) {
  if (!issues.length) return note('No open issues. 🎉')
  body.innerHTML = ''
  for (const it of issues) {
    const f = it.fields || {}
    const row = document.createElement('div')
    row.className = 'issue'
    const key = document.createElement('span')
    key.className = 'issue-key'
    key.textContent = it.key
    const sum = document.createElement('span')
    sum.className = 'issue-sum'
    sum.textContent = f.summary || ''
    const st = document.createElement('span')
    st.className = 'issue-status'
    st.textContent = (f.status && f.status.name) || ''
    row.append(key, sum, st)
    body.appendChild(row)
  }
}

async function load() {
  if (!g) return
  const { site, email, token, jql } = await config()
  if (!site || !email || !token) {
    return note('Add your <b>Jira site</b>, <b>email</b>, and <b>API token</b> in Settings → Jira. Create a token at <b>id.atlassian.com</b>.')
  }
  note('Loading…')
  try {
    const res = await g.fetch(`https://${site}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${email}:${token}`),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jql: jql || DEFAULT_JQL, maxResults: 25, fields: ['summary', 'status', 'priority'] })
    })
    if (!res.ok) {
      const hint = res.status === 401 ? ' (check email + token)' : ''
      return note(`Jira request failed: ${res.status}${hint}`, true)
    }
    const data = await res.json()
    render(data.issues || [])
  } catch (e) {
    note(`Could not reach Jira: ${e && e.message ? e.message : e}`, true)
  }
}

refresh.addEventListener('click', () => void load())
if (g) {
  g.onReady(() => void load())
  g.onActiveChange((a) => a && void load())
  setInterval(() => g.active && void load(), 120000)
}
