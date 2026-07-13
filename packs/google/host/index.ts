import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { defineHost, type HostContext } from '@garretapp/sdk/host'
import type { Api, Events, CalendarEvent } from '../shared/api'

// Installed-app OAuth: emit the auth URL (the UI opens it — the host has no Electron shell), capture
// the redirect on a 127.0.0.1 loopback (Google auto-allows loopback for Desktop clients), exchange
// the code with PKCE. Read-only Calendar scope. Ported verbatim from the built-in google service.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'].join(' ')
const CAL_BASE = 'https://www.googleapis.com/calendar/v3'
const TIMEOUT_MS = 180_000

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  error?: string
  error_description?: string
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  })
  const json = (await res.json()) as TokenResponse
  if (!res.ok || json.error) {
    throw new Error(`Google token error: ${json.error_description || json.error || res.status}`)
  }
  return json
}

async function fetchEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return ''
    const j = (await res.json()) as { email?: string }
    return j.email ?? ''
  } catch {
    return ''
  }
}

/** Interactive sign-in: emit the auth URL, capture the loopback redirect, return tokens. */
async function runOAuth(
  ctx: HostContext<Events>,
  clientId: string,
  clientSecret: string
): Promise<{ refreshToken: string; accessToken: string; expiresAt: number; email: string }> {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
    (resolve, reject) => {
      let redirectUri = ''
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', redirectUri || 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        if (!code && !error) {
          res.statusCode = 204
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;background:#1c1c1e;color:#fff;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div style="text-align:center"><h2>Connected to Garret ✓</h2><p>You can close this tab and return to Garret.</p></div>'
        )
        clearTimeout(timer)
        server.close()
        if (error) return reject(new Error('Google sign-in was cancelled.'))
        if (url.searchParams.get('state') !== state) return reject(new Error('OAuth state mismatch.'))
        resolve({ code: code as string, redirectUri })
      })
      server.on('error', reject)
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('Google sign-in timed out.'))
      }, TIMEOUT_MS)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        redirectUri = `http://127.0.0.1:${port}`
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES,
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        })
        // The host can't open a browser (no Electron shell) — hand the URL to the UI (g.openExternal).
        ctx.emit('auth:url', { url: `${AUTH_URL}?${params.toString()}` })
      })
    }
  )

  const tok = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier
  })
  if (!tok.refresh_token) {
    throw new Error(
      'No refresh token returned. Revoke Garret at myaccount.google.com/permissions, then reconnect.'
    )
  }
  const email = await fetchEmail(tok.access_token)
  return {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiresAt: Date.now() + tok.expires_in * 1000,
    email
  }
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: number }> {
  const tok = await postToken({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  })
  return { accessToken: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 }
}

// Access tokens cached in memory per refresh token; refreshed on demand.
const accessCache = new Map<string, { token: string; expiresAt: number }>()

async function getAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const hit = accessCache.get(refreshToken)
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token
  try {
    const { accessToken, expiresAt } = await refreshAccessToken(clientId, clientSecret, refreshToken)
    accessCache.set(refreshToken, { token: accessToken, expiresAt })
    return accessToken
  } catch {
    throw new Error('Google session expired — reconnect in settings.')
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function calCall(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  path: string,
  params: Record<string, string>
): Promise<any> {
  const token = await getAccessToken(clientId, clientSecret, refreshToken)
  const url = `${CAL_BASE}${path}?${new URLSearchParams(params).toString()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = (j as any)?.error?.message || ''
    } catch {
      /* no body */
    }
    if (res.status === 401) {
      accessCache.delete(refreshToken)
      throw new Error('Google session expired — reconnect in settings.')
    }
    if (res.status === 403) {
      // "API not enabled / disabled" heals once the user enables the Calendar API — throw a plain
      // (non-auth) error so the UI keeps retrying. A real permission/scope 403 is terminal.
      if (/not been used|disabled|not enabled/i.test(detail)) throw new Error(detail)
      throw new Error(detail || 'Google denied access — check Calendar API scope.')
    }
    if (res.status === 429) throw new Error('Google rate-limited.')
    throw new Error(detail || `Google Calendar request failed (${res.status}).`)
  }
  return res.json()
}

function joinUrlOf(item: any): string | undefined {
  if (item.hangoutLink) return item.hangoutLink
  const ep = item.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')
  if (ep?.uri) return ep.uri
  const m = (item.location as string | undefined)?.match(/https?:\/\/\S+/)
  return m?.[0]
}

function stripHtml(s?: string): string | undefined {
  if (!s) return undefined
  const text = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text ? text.slice(0, 800) : undefined
}

function mapEvent(item: any): CalendarEvent {
  const allDay = Boolean(item.start?.date && !item.start?.dateTime)
  return {
    id: item.id,
    title: item.summary || '(no title)',
    start: item.start?.dateTime ?? item.start?.date,
    end: item.end?.dateTime ?? item.end?.date,
    allDay,
    location: item.location,
    joinUrl: joinUrlOf(item),
    url: item.htmlLink,
    status: item.status,
    description: stripHtml(item.description),
    organizer: item.organizer
      ? { email: item.organizer.email, name: item.organizer.displayName, self: item.organizer.self }
      : undefined,
    attendees: Array.isArray(item.attendees)
      ? item.attendees
          .filter((a: any) => !a.resource)
          .map((a: any) => ({
            email: a.email,
            name: a.displayName,
            self: a.self,
            organizer: a.organizer,
            response: a.responseStatus,
            optional: a.optional
          }))
      : undefined
  }
}

function timeMaxFor(range: string): string | undefined {
  const now = new Date()
  if (range === 'today') {
    const d = new Date(now)
    d.setHours(23, 59, 59, 999)
    return d.toISOString()
  }
  if (range === 'day') return new Date(now.getTime() + 24 * 3600_000).toISOString()
  if (range === 'week') return new Date(now.getTime() + 7 * 24 * 3600_000).toISOString()
  return undefined
}

async function fetchEvents(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  calendarId: string,
  q: Record<string, string>
): Promise<CalendarEvent[]> {
  const data = await calCall(
    clientId,
    clientSecret,
    refreshToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    q
  )
  const items = Array.isArray(data.items) ? data.items : []
  return items.filter((i: any) => i.status !== 'cancelled').map(mapEvent)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default defineHost<Api, Events>((ctx) => ({
  connect: async ({ clientId, clientSecret }) => {
    const cid = clientId.trim()
    const secret = clientSecret.trim()
    if (!cid || !secret) throw new Error('Enter the OAuth Client ID and Client secret.')
    const tok = await runOAuth(ctx, cid, secret)
    accessCache.set(tok.refreshToken, { token: tok.accessToken, expiresAt: tok.expiresAt })
    return { email: tok.email, refreshToken: tok.refreshToken }
  },

  listUpcoming: async ({ clientId, clientSecret, refreshToken, range, maxResults, calendarId }) => {
    const q: Record<string, string> = {
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: new Date().toISOString(),
      maxResults: String(Number(maxResults) || 12)
    }
    const timeMax = timeMaxFor(range || 'today')
    if (timeMax) q.timeMax = timeMax
    return fetchEvents(clientId, clientSecret, refreshToken, calendarId || 'primary', q)
  },

  listDay: async ({ clientId, clientSecret, refreshToken, dayOffset, calendarId }) => {
    const day = new Date()
    day.setDate(day.getDate() + (Number(dayOffset) || 0))
    const start = new Date(day)
    start.setHours(0, 0, 0, 0)
    const end = new Date(day)
    end.setHours(23, 59, 59, 999)
    return fetchEvents(clientId, clientSecret, refreshToken, calendarId || 'primary', {
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      maxResults: '50'
    })
  }
}))
