import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Accordion,
  Badge,
  Dot,
  EmptyState,
  ErrorState,
  Field,
  FieldGroup,
  Item,
  Scroll,
  Select,
  SettingsPanel,
  TextInput,
  useActive,
  useGarret,
  useInstanceConfig,
  useOpenSettings,
  type Tone
} from '@garretapp/sdk/react'

// Pull Requests — composed from the SDK's generic components. Account (email + Bitbucket token, +
// Jira token/site for "me" filters) in the pack's SHARED store. PRs listed per configured repo
// (Bitbucket API tokens can't do user-scoped lists). Domain → tone mapping lives here.
const BB = 'https://api.bitbucket.org/2.0'
interface Cfg {
  repos: string
  state: string
  author: string
  authorName: string
  reviewer: string
  reviewState: string
  refreshMin: string
  muted: number[]
}
const DEFAULTS: Cfg = { repos: '', state: 'OPEN', author: 'anyone', authorName: '', reviewer: 'anyone', reviewState: 'any', refreshMin: '5', muted: [] }
const STATE_TONE: Record<string, Tone> = { OPEN: 'accent', MERGED: 'success', DECLINED: 'danger' }
const REVIEW_TONE: Record<string, Tone> = { approved: 'success', changes_requested: 'danger', pending: 'neutral' }

interface PR {
  id: number
  title: string
  state: string
  repo: string
  author?: { display_name?: string; account_id?: string }
  comment_count?: number
  links?: { html?: { href?: string } }
  participants?: { role?: string; state?: string | null; user?: { account_id?: string; display_name?: string } }[]
}
type State = { kind: 'msg'; node: ReactNode } | { kind: 'error'; msg: string } | { kind: 'ok'; prs: PR[] }

function normalizeSite(s: unknown): string {
  const v = String(s || '').trim().replace(/\/+$/, '')
  return v && !/^https?:\/\//i.test(v) ? `https://${v}` : v
}
function parseRepos(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^https?:\/\/bitbucket\.org\//i, '').replace(/\/(pull-requests|src|commits).*$/i, '').replace(/\/+$/, ''))
    .filter((s) => /^[^/]+\/[^/]+$/.test(s))
}
function reviewTone(s?: string | null): Tone {
  return s === 'approved' ? REVIEW_TONE.approved : s === 'changes_requested' ? REVIEW_TONE.changes_requested : REVIEW_TONE.pending
}

function App(): JSX.Element {
  const g = useGarret()
  const active = useActive()
  const { cfg, set, loaded } = useInstanceConfig<Cfg>(DEFAULTS)
  const [showCfg, setShowCfg] = useState(false)
  useOpenSettings(() => setShowCfg((s) => !s))
  const [state, setState] = useState<State>({ kind: 'msg', node: 'Loading…' })

  const load = useCallback(async () => {
    const [email, rawSite] = await Promise.all([g.shared.storage.get<string>('email'), g.shared.storage.get<string>('jiraSite')])
    const [bbToken, jiraToken] = await Promise.all([
      g.shared.secrets.get('bitbucketToken').catch(() => ''),
      g.shared.secrets.get('jiraToken').catch(() => '')
    ])
    const repos = parseRepos(cfg.repos)
    if (!email || !bbToken) return setState({ kind: 'msg', node: <>Add your <b>Atlassian account</b> (email + Bitbucket token) in Settings → Atlassian.</> })
    if (!repos.length) return setState({ kind: 'msg', node: <>Add one or more <b>repos</b> (<code>workspace/repo</code>) in ⋯ → Settings.</> })
    setState({ kind: 'msg', node: 'Loading…' })
    const headers = { Authorization: 'Basic ' + btoa(`${email}:${bbToken}`), Accept: 'application/json' }
    const needMe = cfg.author === 'me' || cfg.reviewer === 'me'
    let me: string | null = null
    if (needMe) {
      const site = normalizeSite(rawSite)
      if (site && jiraToken) {
        try {
          const r = await g.fetch(`${site}/rest/api/3/myself`, { headers: { Authorization: 'Basic ' + btoa(`${email}:${jiraToken}`), Accept: 'application/json' } })
          if (r.ok) me = (await r.json<{ accountId?: string }>()).accountId || null
        } catch {
          /* ignore */
        }
      }
      if (!me) return setState({ kind: 'error', msg: 'The "Me" filter needs your Jira token + site (used to resolve your account).' })
    }
    const passes = (p: PR): boolean => {
      if (cfg.author === 'me' && p.author?.account_id !== me) return false
      if (cfg.author === 'name' && cfg.authorName.trim() && !(p.author?.display_name || '').toLowerCase().includes(cfg.authorName.trim().toLowerCase())) return false
      if (cfg.reviewer === 'me') {
        const mine = (p.participants || []).find((x) => x.user?.account_id === me && x.role === 'REVIEWER')
        if (!mine) return false
        if (cfg.reviewState !== 'any' && reviewTone(mine.state) !== REVIEW_TONE[cfg.reviewState]) return false
      }
      return true
    }
    try {
      const groups = await Promise.all(
        repos
          .map(async (ref) => {
            const [ws, repo] = ref.split('/')
            const stateQ = cfg.state === 'ALL' ? '' : `state=${encodeURIComponent(cfg.state)}&`
            const url =
              `${BB}/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(repo)}/pullrequests?${stateQ}pagelen=30` +
              '&fields=values.id,values.title,values.state,values.author.display_name,values.author.account_id,values.comment_count,values.links.html.href,values.participants.role,values.participants.state,values.participants.user.account_id,values.participants.user.display_name'
            const res = await g.fetch(url, { headers })
            if (!res.ok) {
              let detail = ''
              try {
                detail = (await res.json<{ error?: { message?: string } }>())?.error?.message || ''
              } catch {
                /* no body */
              }
              throw new Error(`${ref}: ${res.status || res.statusText}${detail ? ' — ' + detail : ''}`)
            }
            return (await res.json<{ values?: PR[] }>()).values?.map((p) => ({ ...p, repo: ref })) || []
          })
          .map((pr) => pr.catch((e: Error) => ({ error: e.message })))
      )
      const prs: PR[] = []
      const errors: string[] = []
      for (const grp of groups) {
        if (Array.isArray(grp)) prs.push(...grp.filter(passes))
        else if (grp && 'error' in grp) errors.push(grp.error)
      }
      if (!prs.length && errors.length) {
        const auth = errors.some((e) => /\b(401|403)\b/.test(e))
        return setState({ kind: 'error', msg: auth ? 'Bitbucket auth failed — the token needs Bitbucket read access (a separate Bitbucket API token / app password, not the Jira one).' : `Could not load: ${errors.join('; ')}` })
      }
      setState({ kind: 'ok', prs })
    } catch (e) {
      setState({ kind: 'error', msg: `Could not reach Bitbucket: ${(e as Error)?.message || e}` })
    }
  }, [g, cfg])

  useEffect(() => {
    if (loaded) void load()
  }, [loaded, load])
  useEffect(() => {
    const m = Number(cfg.refreshMin)
    if (!(m > 0)) return
    const t = setInterval(() => active && void load(), m * 60000)
    return () => clearInterval(t)
  }, [cfg.refreshMin, active, load])

  if (showCfg) {
    return (
      <SettingsPanel onDone={() => setShowCfg(false)}>
        <FieldGroup>
          <Field label="Repos"><TextInput value={cfg.repos} placeholder="workspace/repo, workspace/repo2" onCommit={(v) => set({ repos: v })} /></Field>
          <Field label="State"><Select value={cfg.state} options={[['OPEN', 'Open'], ['MERGED', 'Merged'], ['DECLINED', 'Declined'], ['ALL', 'All']]} onChange={(v) => set({ state: v })} /></Field>
          <Field label="Author"><Select value={cfg.author} options={[['anyone', 'Anyone'], ['me', 'Me'], ['name', 'Someone']]} onChange={(v) => set({ author: v })} /></Field>
          {cfg.author === 'name' && <Field label="Author name"><TextInput value={cfg.authorName} placeholder="display name" onCommit={(v) => set({ authorName: v })} /></Field>}
          <Field label="Reviewer"><Select value={cfg.reviewer} options={[['anyone', 'Anyone'], ['me', 'Me']]} onChange={(v) => set({ reviewer: v })} /></Field>
          <Field label="My review"><Select value={cfg.reviewState} options={[['any', 'Any'], ['pending', 'Needs my review'], ['approved', 'Approved'], ['changes_requested', 'Changes requested']]} onChange={(v) => set({ reviewState: v })} /></Field>
          <Field label="Refresh"><Select value={cfg.refreshMin} options={[['0', 'Manual'], ['5', '5 min'], ['15', '15 min'], ['30', '30 min']]} onChange={(v) => set({ refreshMin: v })} /></Field>
        </FieldGroup>
      </SettingsPanel>
    )
  }

  if (state.kind === 'msg') return <EmptyState>{state.node}</EmptyState>
  if (state.kind === 'error') return <ErrorState>{state.msg}</ErrorState>

  const muted = cfg.muted || []
  const shown = state.prs.filter((p) => !muted.includes(p.id))
  if (!shown.length) return <EmptyState>{muted.length ? 'No matching pull requests.' : 'No open pull requests.'}</EmptyState>
  const byRepo: Record<string, PR[]> = {}
  for (const p of shown) (byRepo[p.repo] = byRepo[p.repo] || []).push(p)

  return (
    <Scroll>
      {Object.entries(byRepo).map(([repo, prs]) => (
        <Accordion key={repo} title={repo} aside={prs.length}>
          {prs.map((p) => {
            const reviewers = (p.participants || []).filter((x) => x.role === 'REVIEWER')
            return (
              <Item
                key={p.id}
                onClick={() => p.links?.html?.href && g.openExternal(p.links.html.href)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  set({ muted: [...muted, p.id] })
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span className="gx-truncate">{p.title || '(untitled)'}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {p.author?.display_name && <span className="gx-muted gx-truncate" style={{ fontSize: 11, maxWidth: '40%' }}>{p.author.display_name}</span>}
                    {reviewers.length > 0 && (
                      <span style={{ display: 'inline-flex', gap: 3 }}>
                        {reviewers.slice(0, 5).map((r, i) => (
                          <Dot key={i} tone={reviewTone(r.state)} title={`${r.user?.display_name || ''} · ${r.state || 'pending'}`} />
                        ))}
                      </span>
                    )}
                    {p.comment_count ? <span className="gx-muted" style={{ fontSize: 11 }}>💬 {p.comment_count}</span> : null}
                    <span style={{ marginLeft: 'auto' }}><Badge tone={STATE_TONE[p.state] || 'accent'}>{p.state}</Badge></span>
                  </span>
                </div>
              </Item>
            )
          })}
        </Accordion>
      ))}
      {muted.length > 0 && (
        <button className="gx-btn gx-btn--ghost" style={{ width: '100%', marginTop: 4 }} onClick={() => set({ muted: [] })}>
          {muted.length} muted · Unmute all
        </button>
      )}
    </Scroll>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
