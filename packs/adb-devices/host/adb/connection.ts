import { connect } from 'node:net'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AdbServerClient } from '@yume-chan/adb'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import type { HostContext } from '@garretapp/sdk/host'

// We talk to the LOCAL adb server (the daemon `adb` / Android Studio runs on 127.0.0.1:5037).
// ya-webadb's TCP transport connects to it — it does NOT embed adb, so a server must be running.
const HOST = '127.0.0.1'
const PORT = 5037

let client: AdbServerClient | null = null
export function getClient(): AdbServerClient {
  if (!client) client = new AdbServerClient(new AdbServerNodeTcpConnector({ host: HOST, port: PORT }))
  return client
}
function resetClient(): void {
  client = null
}

/** Cheap reachability probe — a raw TCP connect to the adb server port (no adb protocol). */
function serverReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: HOST, port: PORT })
    const finish = (v: boolean): void => {
      sock.destroy()
      resolve(v)
    }
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.setTimeout(1000, () => finish(false))
  })
}

/**
 * Ensure a reachable adb server: use it if already running; else start it via a system `adb`
 * (`process` capability); else fail with an install hint the UI shows the user.
 */
/** Locate `adb`: PATH first (via the SDK's login-shell probe), then the standard Android SDK dirs
 *  (Android Studio installs adb there but usually NOT on the shell PATH). */
async function findAdb(ctx: HostContext): Promise<string | null> {
  try {
    return await ctx.resolveBinary('adb', { hint: 'brew install android-platform-tools' })
  } catch {
    /* not on PATH — fall through to SDK locations */
  }
  const candidates = [
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), // macOS default
    join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'), // linux default
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb'
  ].filter((p): p is string => typeof p === 'string')
  return candidates.find((p) => existsSync(p)) ?? null
}

export async function ensureServer(ctx: HostContext): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await serverReachable()) return { ok: true }

  const adb = await findAdb(ctx)
  if (!adb) {
    return { ok: false, error: 'adb not found — install Android platform-tools (brew install android-platform-tools), then Retry.' }
  }

  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = ctx.spawn([adb, 'start-server'])
    let err = ''
    child.stderr?.on('data', (d: Buffer) => (err += String(d)))
    const t = setTimeout(() => resolve({ code: null, stderr: err }), 5000) // don't hang if adb never exits
    child.on('close', (c) => {
      clearTimeout(t)
      resolve({ code: c, stderr: err })
    })
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ code: null, stderr: err || String(e) })
    })
  })
  resetClient() // reconnect against the freshly-started server
  if (await serverReachable()) return { ok: true }
  // Surface adb's own words — a version/port/socket conflict is otherwise invisible to the user.
  const detail = stderr.trim() || (code != null ? `adb exited with code ${code}` : 'adb start-server timed out')
  return { ok: false, error: `adb is installed but its server could not start: ${detail}` }
}
