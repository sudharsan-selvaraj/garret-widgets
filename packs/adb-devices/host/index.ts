import { defineHost } from '@garretapp/sdk/host'
import type { AdbServerClient } from '@yume-chan/adb'
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  type AndroidKeyEventMeta,
  AndroidMotionEventAction,
  ScrcpyPointerId,
  type ScrcpyControlMessageWriter
} from '@yume-chan/scrcpy'
import type { Api, Events, AdbDevice, AdbStatus, MirrorConfig, DeviceAction, PointerAction } from '../shared/api'
import { getClient, ensureServer } from './adb/connection'
import { startTracker } from './adb/tracker'
import { resolveDeviceName } from './adb/deviceName'
import { openMirror } from './adb/mirror'
import { createHub, type MirrorHub } from './adb/session'

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

const MOTION: Record<PointerAction, AndroidMotionEventAction> = {
  down: AndroidMotionEventAction.Down,
  move: AndroidMotionEventAction.Move,
  up: AndroidMotionEventAction.Up,
  cancel: AndroidMotionEventAction.Cancel
}

// Nav/system actions that are just a key down+up.
const ACTION_KEY: Partial<Record<DeviceAction, AndroidKeyCode>> = {
  back: AndroidKeyCode.AndroidBack,
  home: AndroidKeyCode.AndroidHome,
  appSwitch: AndroidKeyCode.AndroidAppSwitch,
  power: AndroidKeyCode.Power,
  volumeUp: AndroidKeyCode.VolumeUp,
  volumeDown: AndroidKeyCode.VolumeDown
}

// One host is forked per placed surface: a LIST surface calls status()/listDevices() (→ the tracker);
// a MIRROR surface calls mirror()/audio() (→ one scrcpy session hub). Both start LAZILY, so a mirror
// window never opens a track socket and a list window never opens a scrcpy session.
export default defineHost<Api, Events>((ctx) => {
  // ── device list (event-driven tracker) ─────────────────────────────────────────────────────────
  let observer: AdbServerClient.DeviceObserver | null = null
  let current: AdbDevice[] = []
  let status: AdbStatus = { ok: false, state: 'connecting' }
  let started = false // lazy-start guard so status()/listDevices() kick the tracker exactly once
  let generation = 0 // bumped per runTracker; a superseded run bails instead of racing shared state
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 0 // consecutive auto-reconnect attempts (drives the delay; reset on a clean connect)
  const MAX_AUTO = 5

  const nameCache = new Map<string, string>() // serial → resolved marketing name (stable per device)
  let rawDevices: AdbDevice[] = [] // latest un-enriched list from the tracker

  const setStatus = (s: AdbStatus): void => {
    status = s
    ctx.emit('adb:status', s)
  }
  // Overlay cached marketing names onto the raw list, publish, and remember as `current`.
  const emitDevices = (): void => {
    current = rawDevices.map((d) => ({ ...d, name: nameCache.get(d.serial) ?? d.name }))
    ctx.emit('devices:changed', current)
  }
  // Resolve names for newly-seen online devices (async getprop), then re-emit — cached so a device is
  // looked up once. Best-effort: a failed lookup just leaves the UI on the adb model fallback.
  const resolveNames = (list: AdbDevice[]): void => {
    for (const d of list) {
      if (d.state !== 'device' || nameCache.has(d.serial)) continue
      void resolveDeviceName(getClient(), d.serial).then((name) => {
        if (name) {
          nameCache.set(d.serial, name)
          emitDevices()
        }
      })
    }
  }
  // The track-devices socket dropped (adb restart, unplug churn, idle close) or the initial connect
  // failed. Auto-recover with exponential backoff instead of dead-ending on a raw stream error like
  // "ExactReadable ended"; after MAX_AUTO tries fall to a friendly terminal error with manual Retry.
  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer) return
    if (backoff >= MAX_AUTO) {
      return setStatus({ ok: false, state: 'error', error: 'Lost connection to adb. Make sure it’s running, then Retry.' })
    }
    setStatus({ ok: false, state: 'connecting' })
    const delay = Math.min(500 * 2 ** backoff, 8000)
    backoff += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void runTracker()
    }, delay)
  }
  // A generation token guards against overlapping runs (a reconnect timer / manual retry firing while
  // a prior run is mid-`await`): each run bumps `generation`, and a superseded run bails after its
  // awaits — stopping any observer it opened — instead of corrupting the shared observer/status.
  const runTracker = async (): Promise<void> => {
    const gen = ++generation
    try {
      await observer?.stop()
    } catch {
      /* already dead */
    }
    observer = null
    current = []
    rawDevices = []
    setStatus({ ok: false, state: 'connecting' })
    const r = await ensureServer(ctx)
    if (gen !== generation) return // superseded while probing
    if (!r.ok) return setStatus({ ok: false, state: 'no-adb', error: r.error })
    try {
      const obs = await startTracker(getClient(), (devices) => {
        rawDevices = devices
        emitDevices()
        resolveNames(devices)
      })
      if (gen !== generation) {
        try {
          await obs.stop() // a newer run took over — don't leak this observer
        } catch {
          /* already dead */
        }
        return
      }
      observer = obs
      obs.onError(() => scheduleReconnect())
      backoff = 0 // clean connect → reset the backoff ladder
      setStatus({ ok: true, state: 'connected' })
    } catch {
      if (gen === generation) scheduleReconnect()
    }
  }
  // Lazy start on first access; the generation guard makes any later forced re-run (retry/reconnect) safe.
  const ensureTracking = (): void => {
    if (started) return
    started = true
    void runTracker()
  }

  // ── mirror (one scrcpy session hub per host; drains both media streams regardless of subscription,
  //    ref-counted so it closes + resets on the last unsubscribe or on open failure) ───────────────
  let hub: MirrorHub | null = null
  let hubSerial: string | null = null
  let closingHub: Promise<void> | null = null // in-flight teardown; a re-open must serialize on it
  const getHub = (serial: string, cfg: MirrorConfig): MirrorHub => {
    // One host is forked per surface, so serial is stable — but guard anyway so a stray mismatched
    // call can't silently piggyback on (and mirror) the wrong device.
    if (hub && hubSerial !== serial) {
      closingHub = hub.close()
      hub = null
      hubSerial = null
    }
    if (hub) return hub
    hubSerial = serial
    const prevClose = closingHub // teardown of a previous session for this host, if any
    return (hub = createHub(
      async () => {
        // Don't overlap a fresh scrcpy session with a still-closing one (two app_process servers +
        // display contention). onEmpty's close() is async; wait it out before re-opening.
        await prevClose?.catch(() => {})
        const r = await ensureServer(ctx)
        if (!r.ok) throw new Error(r.error)
        return openMirror(getClient(), serial, cfg)
      },
      () => {
        const dead = hub
        hub = null // reset so a later subscribe re-opens a fresh session
        hubSerial = null
        closingHub = dead ? dead.close() : null // record teardown so the re-open serializes on it
        void closingHub
      }
    ))
  }

  // ── control (input injection) ───────────────────────────────────────────────────────────────────
  // Runs `fn` against the EXISTING hub's controller only — never getHub (a control call must not spin
  // up a subscriber-less zombie scrcpy session). No-ops unless this host is actively mirroring `serial`.
  const withControl = (
    serial: string,
    fn: (c: ScrcpyControlMessageWriter) => Promise<void>
  ): Promise<void> => (hub && hubSerial === serial ? hub.control(fn) : Promise.resolve())

  ctx.onDispose(async () => {
    disposed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    await observer?.stop()
    await hub?.close()
  })

  return {
    status: async () => {
      void ensureTracking()
      return status
    },
    listDevices: async () => {
      void ensureTracking()
      return current
    },
    retry: async () => {
      backoff = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      started = true
      await runTracker() // forced fresh run; generation guard supersedes any in-flight attempt
    },
    mirror: ({ serial, ...cfg }) =>
      ctx.stream((out, signal) => {
        const off = getHub(serial, cfg).subscribeVideo({
          push: (c) => out.push(c),
          end: () => out.end(),
          error: (e) => out.error(e)
        })
        signal.addEventListener('abort', off)
      }),
    audio: ({ serial }) =>
      ctx.stream((out, signal) => {
        const off = getHub(serial, {}).subscribeAudio({
          push: (c) => out.push(c),
          end: () => out.end(),
          error: (e) => out.error(e)
        })
        signal.addEventListener('abort', off)
      }),

    pointer: ({ serial, action, x, y, w, h }) =>
      withControl(serial, (c) =>
        c.injectTouch({
          pointerId: ScrcpyPointerId.Finger,
          action: MOTION[action],
          pointerX: clamp01(x) * w,
          pointerY: clamp01(y) * h,
          videoWidth: w,
          videoHeight: h,
          pressure: action === 'up' || action === 'cancel' ? 0 : 1,
          actionButton: 0,
          buttons: 0
        })
      ),

    scroll: ({ serial, x, y, w, h, dx, dy }) =>
      withControl(serial, (c) =>
        c.injectScroll({
          pointerX: clamp01(x) * w,
          pointerY: clamp01(y) * h,
          videoWidth: w,
          videoHeight: h,
          scrollX: dx,
          scrollY: dy,
          buttons: 0
        })
      ),

    key: ({ serial, action, keyCode, metaState, repeat }) =>
      withControl(serial, (c) =>
        c.injectKeyCode({
          action: action === 'up' ? AndroidKeyEventAction.Up : AndroidKeyEventAction.Down,
          keyCode: keyCode as AndroidKeyCode,
          repeat: repeat ?? 0,
          metaState: (metaState ?? 0) as AndroidKeyEventMeta
        })
      ),

    text: ({ serial, text }) => withControl(serial, (c) => c.injectText(text)),

    action: ({ serial, kind }) =>
      withControl(serial, async (c) => {
        if (kind === 'rotate') return c.rotateDevice()
        if (kind === 'notifications') return c.expandNotificationPanel()
        const keyCode = ACTION_KEY[kind]
        if (keyCode === undefined) return
        await c.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, repeat: 0, metaState: 0 })
        await c.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, repeat: 0, metaState: 0 })
      })
  }
})
