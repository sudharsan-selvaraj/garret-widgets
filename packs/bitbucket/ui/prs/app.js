// Bitbucket: lists your open pull requests. Pure UI — the user's Atlassian API token (basic auth)
// from the encrypted secrets store, email from settings. Network via g.fetch, gated to
// network:api.bitbucket.org. Two calls: /2.0/user (→ your uuid) then /2.0/pullrequests/{uuid}.
const g = window.__garret
const body = document.getElementById('body')
const refresh = document.getElementById('refresh')

function note(html, isErr) {
  body.innerHTML = `<div class="note${isErr ? ' err' : ''}">${html}</div>`
}

async function config() {
  const email = ((await g.storage.get('email')) || '').trim()
  const token = (await g.secrets.get('token').catch(() => '')) || ''
  return { email, token }
}

function render(prs) {
  if (!prs.length) return note('No open pull requests. 🎉')
  body.innerHTML = ''
  for (const pr of prs) {
    const row = document.createElement('div')
    row.className = 'pr'
    const t = document.createElement('span')
    t.className = 'pr-title'
    t.textContent = pr.title || '(untitled)'
    const repo = document.createElement('span')
    repo.className = 'pr-repo'
    repo.textContent = (pr.destination && pr.destination.repository && pr.destination.repository.full_name) || ''
    row.append(t, repo)
    body.appendChild(row)
  }
}

async function load() {
  if (!g) return
  const { email, token } = await config()
  if (!email || !token) {
    return note('Add your <b>email</b> and <b>API token</b> in Settings → Bitbucket. Create a token at <b>id.atlassian.com</b>.')
  }
  const auth = 'Basic ' + btoa(`${email}:${token}`)
  const headers = { Authorization: auth, Accept: 'application/json' }
  note('Loading…')
  try {
    const me = await g.fetch('https://api.bitbucket.org/2.0/user', { headers })
    if (!me.ok) {
      const hint = me.status === 401 ? ' (check email + token, and that the token has Bitbucket access)' : ''
      return note(`Bitbucket auth failed: ${me.status}${hint}`, true)
    }
    const uuid = (await me.json()).uuid
    const url =
      `https://api.bitbucket.org/2.0/pullrequests/${encodeURIComponent(uuid)}` +
      '?state=OPEN&fields=values.title,values.destination.repository.full_name,values.links.html.href&pagelen=25'
    const res = await g.fetch(url, { headers })
    if (!res.ok) return note(`Could not load pull requests: ${res.status}`, true)
    render((await res.json()).values || [])
  } catch (e) {
    note(`Could not reach Bitbucket: ${e && e.message ? e.message : e}`, true)
  }
}

refresh.addEventListener('click', () => void load())
if (g) {
  g.onReady(() => void load())
  g.onActiveChange((a) => a && void load())
  setInterval(() => g.active && void load(), 120000)
}
