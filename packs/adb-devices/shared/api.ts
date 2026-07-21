/** A serializable view of an adb device (bigint transportId stringified for the wire). */
export interface AdbDevice {
  serial: string
  state: 'unauthorized' | 'offline' | 'device'
  product?: string
  model?: string
  device?: string
  transportId: string
  /** Human marketing name resolved from device props (e.g. "OnePlus Nord 5", "Galaxy S21"). Arrives
   *  asynchronously after the initial list (a getprop round-trip), so it may be absent at first. */
  name?: string
}

export type AdbConnState = 'connecting' | 'connected' | 'no-adb' | 'error'

/** Whether the local adb server is reachable, and if not, why (drives the UI's guidance). */
export interface AdbStatus {
  ok: boolean
  state: AdbConnState
  /** user-facing hint when `!ok` (e.g. how to install platform-tools). */
  error?: string
}

/** Tunables for a scrcpy mirror session (all optional; sensible defaults in the host). */
export interface MirrorConfig {
  videoBitRate?: number
  maxFps?: number
  /** longest edge in px; 0 = device native. */
  maxSize?: number
}

/** Video packets streamed host→UI: one `meta` first, then a `config` (SPS/PPS), then `frame`s. */
export type VideoChunk =
  | { kind: 'meta'; width: number; height: number; videoCodec: string; audioCodec: string | null }
  | { kind: 'config'; data: Uint8Array }
  | { kind: 'frame'; data: Uint8Array; keyframe: boolean; timestamp: number }

/** Audio packets (absent on Android <11): a `config` then `frame`s. */
export type AudioChunk =
  | { kind: 'config'; data: Uint8Array }
  | { kind: 'frame'; data: Uint8Array; timestamp: number }

/** A pointer/touch phase. `cancel` aborts a gesture (e.g. a rotation mid-drag) without a tap-release. */
export type PointerAction = 'down' | 'move' | 'up' | 'cancel'

/** A one-shot hardware/nav/system action. */
export type DeviceAction =
  | 'back'
  | 'home'
  | 'appSwitch'
  | 'power'
  | 'volumeUp'
  | 'volumeDown'
  | 'rotate'
  | 'notifications'

/** A pointer event. `x`/`y` are normalized [0,1] against the currently displayed frame; `w`/`h` are
 *  that frame's pixel dims (from the decoder) — so mapping stays correct across rotation. */
export interface PointerInput {
  serial: string
  action: PointerAction
  x: number
  y: number
  w: number
  h: number
}

/** Host methods the UI calls (the controller boundary). Import Stream from '@garretapp/sdk'. */
export interface Api {
  status(): Promise<AdbStatus>
  /** Current device list (also pushed live via the `devices:changed` event). */
  listDevices(): Promise<AdbDevice[]>
  /** Re-attempt the adb connection (after the user installs platform-tools / plugs in). */
  retry(): Promise<void>
  /** Live H.264 video for a device (mirror surface). Starts the scrcpy session on subscribe. */
  mirror(args: { serial: string } & MirrorConfig): import('@garretapp/sdk').Stream<VideoChunk>
  /** Live Opus audio for a device; the stream ends immediately on Android <11. */
  audio(args: { serial: string }): import('@garretapp/sdk').Stream<AudioChunk>

  // ── control (best-effort; no-op if the device isn't being mirrored) ─────────────────────────────
  /** Inject a touch/drag event at a normalized point on the current frame. */
  pointer(a: PointerInput): Promise<void>
  /** Inject a wheel scroll at a normalized point (`dx`/`dy` in wheel steps). */
  scroll(a: { serial: string; x: number; y: number; w: number; h: number; dx: number; dy: number }): Promise<void>
  /** Inject a key event (Android keyCode + optional meta/repeat). */
  key(a: { serial: string; action: 'down' | 'up'; keyCode: number; metaState?: number; repeat?: number }): Promise<void>
  /** Inject unicode text into the focused field (respects the device's IME/layout). */
  text(a: { serial: string; text: string }): Promise<void>
  /** A one-shot nav/system action (back/home/recents/power/volume/rotate/notifications). */
  action(a: { serial: string; kind: DeviceAction }): Promise<void>
}

/** Host → UI events (live, event-driven — no polling). A `type` (not `interface`) so it satisfies the
 *  SDK's `EventMap` index-signature constraint. */
export type Events = {
  'devices:changed': AdbDevice[]
  'adb:status': AdbStatus
}
