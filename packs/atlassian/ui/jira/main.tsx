import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Badge,
  Dot,
  EmptyState,
  ErrorState,
  Field,
  FieldGroup,
  Item,
  Scroll,
  NumberInput,
  Select,
  SettingsPanel,
  TextInput,
  Switch,
  useActive,
  useGarret,
  useInstanceConfig,
  useWidgetMenu,
  type Tone
} from '@garretapp/sdk/react'

// Jira Tickets — composed from the SDK's generic components. Account in the pack's SHARED store;
// per-placement filters via useInstanceConfig. Custom title (g.setTitle → frame header), manual
// refresh (⋯→Refresh), and notify-on-new (diff vs a seen-set, g.notify) at parity with the built-in.
interface Cfg {
  title: string
  project: string
  onlyMine: boolean
  statuses: string
  sprint: string
  jql: string
  maxResults: number
  refreshMin: string
  notify: boolean
}
const DEFAULTS: Cfg = { title: '', project: '', onlyMine: true, statuses: '', sprint: 'any', jql: '', maxResults: 15, refreshMin: '5', notify: false }
const CAT_TONE: Record<string, Tone> = { 'To Do': 'neutral', 'In Progress': 'accent', Done: 'success' }

interface Issue {
  key: string
  fields?: { summary?: string; status?: { name?: string; statusCategory?: { name?: string } } }
}
type State = { kind: 'msg'; node: ReactNode } | { kind: 'error'; msg: string } | { kind: 'ok'; issues: Issue[] }

function normalizeSite(s: unknown): string {
  const v = String(s || '').trim().replace(/\/+$/, '')
  return v && !/^https?:\/\//i.test(v) ? `https://${v}` : v
}
function buildJql(c: Cfg): string {
  if (c.jql.trim()) return c.jql.trim()
  const parts: string[] = []
  if (c.project.trim()) parts.push(`project = "${c.project.trim()}"`)
  if (c.onlyMine) parts.push('assignee = currentUser()')
  const statuses = c.statuses.split(',').map((s) => s.trim()).filter(Boolean)
  if (statuses.length) parts.push(`status in (${statuses.map((s) => `"${s}"`).join(', ')})`)
  if (c.sprint === 'open') parts.push('sprint in openSprints()')
  return `${parts.length ? parts.join(' AND ') + ' ' : ''}ORDER BY created DESC`
}

function App(): JSX.Element {
  const g = useGarret()
  const active = useActive()
  const { cfg, set, loaded } = useInstanceConfig<Cfg>(DEFAULTS)
  const [showCfg, setShowCfg] = useState(false)
  const [state, setState] = useState<State>({ kind: 'msg', node: 'Loading…' })
  const [site, setSite] = useState('')
  const seen = useRef<Set<string> | null>(null) // null until the persisted seen-set loads

  // Apply the custom title to the frame header (empty → falls back to the widget name).
  useEffect(() => {
    if (loaded) g.setTitle(cfg.title.trim())
  }, [g, loaded, cfg.title])

  const load = useCallback(async () => {
    const [email, rawSite] = await Promise.all([g.shared.storage.get<string>('email'), g.shared.storage.get<string>('jiraSite')])
    const token = await g.shared.secrets.get('jiraToken').catch(() => '')
    const s = normalizeSite(rawSite)
    setSite(s)
    if (!s || !email || !token) {
      return setState({ kind: 'msg', node: <>Add your <b>Atlassian account</b> (email, Jira token, site) in Settings → Atlassian.</> })
    }
    setState((prev) => (prev.kind === 'ok' ? prev : { kind: 'msg', node: 'Loading…' }))
    try {
      const res = await g.fetch(`${s}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`${email}:${token}`), Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql: buildJql(cfg), maxResults: Number(cfg.maxResults) || 15, fields: ['summary', 'status', 'priority'] })
      })
      if (!res.ok) {
        const code = res.status || res.statusText
        return setState({ kind: 'error', msg: code === 401 || code === 403 ? 'Jira auth failed — check email + Jira token.' : `Jira request failed (${code}).` })
      }
      const issues = (await res.json<{ issues?: Issue[] }>()).issues || []
      maybeNotify(issues, s)
      setState({ kind: 'ok', issues })
    } catch (e) {
      setState({ kind: 'error', msg: `Could not reach Jira: ${(e as Error)?.message || e}` })
    }
  }, [g, cfg])

  // Notify on newly-appeared tickets vs the persisted seen-set (skips the first load / seeding).
  const maybeNotify = (issues: Issue[], base: string): void => {
    const ids = issues.map((i) => i.key)
    const prev = seen.current
    if (prev) {
      const fresh = issues.filter((i) => !prev.has(i.key))
      if (cfg.notify && fresh.length) {
        // Click opens the newest ticket (Jira's browse deep-link).
        const url = base ? `${base}/browse/${fresh[0].key}` : undefined
        g.notify(`${fresh.length} new Jira ticket${fresh.length > 1 ? 's' : ''}`, fresh[0].fields?.summary || fresh[0].key, { url })
      }
    }
    seen.current = new Set(ids)
    void g.instanceStorage.set('seen', ids)
  }

  useEffect(() => {
    if (!loaded) return
    void (async () => {
      const saved = await g.instanceStorage.get<string[]>('seen')
      seen.current = Array.isArray(saved) ? new Set(saved) : null
      await load()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, load])
  useEffect(() => {
    const m = Number(cfg.refreshMin)
    if (!(m > 0)) return
    // Poll while the board is active; if "Notify on new" is on, keep polling when the board is
    // idle too — throttled to a >=5 min floor — so new-ticket alerts fire even when you're not
    // looking. No extra process: this is the widget's own already-running webview.
    const period = (active ? m : Math.max(m, 5)) * 60000
    const t = setInterval(() => (active || cfg.notify) && void load(), period)
    return () => clearInterval(t)
  }, [cfg.refreshMin, active, cfg.notify, load])
  useWidgetMenu([
    { id: 'settings', label: 'Settings', run: () => setShowCfg((s) => !s) },
    { id: 'refresh', label: 'Refresh', run: () => void load() }
  ])

  if (showCfg) {
    return (
      <SettingsPanel onDone={() => setShowCfg(false)}>
        <FieldGroup>
          <Field label="Title"><TextInput value={cfg.title} placeholder="optional" onCommit={(v) => set({ title: v })} /></Field>
          <Field label="Project key"><TextInput value={cfg.project} placeholder="e.g. OCA" onCommit={(v) => set({ project: v })} /></Field>
          <Field label="Only mine"><Switch on={cfg.onlyMine} onChange={(v) => set({ onlyMine: v })} /></Field>
          <Field label="Statuses"><TextInput value={cfg.statuses} placeholder="In Progress, In Review" onCommit={(v) => set({ statuses: v })} /></Field>
          <Field label="Sprint"><Select value={cfg.sprint} options={[['any', 'Any'], ['open', 'Active sprint']]} onChange={(v) => set({ sprint: v })} /></Field>
          <Field label="Max results"><NumberInput value={cfg.maxResults} onCommit={(v) => set({ maxResults: v })} /></Field>
          <Field label="Refresh"><Select value={cfg.refreshMin} options={[['0', 'Manual'], ['1', '1 min'], ['5', '5 min'], ['15', '15 min']]} onChange={(v) => set({ refreshMin: v })} /></Field>
          <Field label="Notify on new"><Switch on={cfg.notify} onChange={(v) => set({ notify: v })} /></Field>
        </FieldGroup>
        <FieldGroup>
          <Field label="JQL"><TextInput value={cfg.jql} placeholder="advanced — overrides the above" onCommit={(v) => set({ jql: v })} /></Field>
        </FieldGroup>
      </SettingsPanel>
    )
  }

  if (state.kind === 'msg') return <EmptyState>{state.node}</EmptyState>
  if (state.kind === 'error') return <ErrorState>{state.msg}</ErrorState>
  if (!state.issues.length) return <EmptyState>No matching tickets.</EmptyState>
  return (
    <Scroll>
      {state.issues.map((it) => {
        const tone = CAT_TONE[it.fields?.status?.statusCategory?.name || 'To Do'] || 'neutral'
        return (
          <Item
            key={it.key}
            leading={<Dot tone={tone} />}
            trailing={<Badge tone={tone}>{it.fields?.status?.name || 'Unknown'}</Badge>}
            onClick={() => site && g.openExternal(`${site}/browse/${it.key}`)}
          >
            <span className="gx-truncate">
              <span style={{ color: 'var(--gx-text-2)', fontWeight: 600 }}>{it.key}</span> {it.fields?.summary || ''}
            </span>
          </Item>
        )
      })}
    </Scroll>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
