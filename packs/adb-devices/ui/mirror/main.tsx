import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { useHost, useProps, useGarret } from '@garretapp/sdk/react'
import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'
import { ScrcpyVideoCodecId, type ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy'
import type { Api, VideoChunk, AudioChunk } from '../../shared/api'
import { MirrorAudio } from './audio'
import { attachPointerControl } from './pointer'
import { attachKeyboardControl } from './keyboard'
import { NavBar, NAVBAR_W } from './NavBar'

// The vertical control column occupies NAVBAR_W px to the right of the device; reserve it in the
// aspect lock so the host sizes the DEVICE area (canvas) to the video ratio, not the whole window.
const ASPECT_INSET = { width: NAVBAR_W }

/**
 * The floating "phone on the desktop" mirror surface. Reads its device serial from g.props, streams
 * H.264 video + Opus audio from the host, decodes with WebCodecs (→ a WebGL canvas / Web Audio), and
 * locks the window to the device aspect ratio once known. Frameless + transparent (per the manifest),
 * so it supplies its own drag region + close button.
 */
function Mirror(): JSX.Element {
  const host = useHost<Api>()
  const g = useGarret()
  const { serial } = useProps<{ serial: string; model?: string }>()
  const screenRef = useRef<HTMLDivElement>(null)
  // connecting → live → lost (device unplugged / adb or scrcpy died). `attempt` re-runs the effect
  // to reconnect; `reason` is the user-facing cause on `lost`.
  const [phase, setPhase] = useState<'connecting' | 'live' | 'lost'>('connecting')
  const [reason, setReason] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!serial) return
    let disposed = false
    setPhase('connecting')
    setReason(null)
    const canvas = document.createElement('canvas')
    canvas.className = 'screen'
    screenRef.current?.appendChild(canvas)
    const renderer = new WebGLVideoFrameRenderer(canvas)
    const decoder = new WebCodecsVideoDecoder({ codec: ScrcpyVideoCodecId.H264, renderer })
    const writer = decoder.writable.getWriter()

    // Current frame dims drive both the aspect lock and touch-coordinate mapping (kept in a ref so the
    // pointer handlers always read the latest across rotation).
    let dims: { w: number; h: number } | null = null
    const control = attachPointerControl(canvas, host, serial, () => dims)
    const keyboard = attachKeyboardControl(host, serial)

    decoder.sizeChanged(({ width, height }) => {
      // sizeChanged fires on every scrcpy config/keyframe, NOT only on rotation — so act ONLY when the
      // dimensions actually change. Otherwise a keyframe landing mid-tap would spuriously cancel the
      // gesture (the tap never gets its `up`). On a REAL change, re-lock the window + re-map touch and
      // cancel any in-flight gesture (its old coordinates are meaningless in the new orientation).
      if (disposed || !width || !height) return
      if (dims && dims.w === width && dims.h === height) return
      control.cancelGesture()
      dims = { w: width, h: height }
      g.window.setAspectRatio(width / height, ASPECT_INSET)
    })

    // The device disconnected / adb/scrcpy died. Cancel the streams so the host's hub sees the last
    // unsubscribe and tears down the on-device scrcpy server NOW (a video error while the device stays
    // connected wouldn't otherwise release it until the window closes). Unlock the reserved control
    // column so the card fills the window, then surface it. Runs once.
    let ended = false
    const lost = (why: string): void => {
      if (disposed || ended) return
      ended = true
      call.cancel()
      audioCall.cancel()
      if (dims) g.window.setAspectRatio(dims.w / dims.h) // drop ASPECT_INSET — no column while lost
      setReason(why)
      setPhase('lost')
    }

    const call = host.mirror({ serial })
    call.onData((chunk: VideoChunk) => {
      if (disposed) return
      if (chunk.kind === 'meta') {
        setPhase('live')
        if (chunk.width && chunk.height) {
          dims = { w: chunk.width, h: chunk.height }
          g.window.setAspectRatio(chunk.width / chunk.height, ASPECT_INSET)
        }
        return
      }
      const packet: ScrcpyMediaStreamPacket =
        chunk.kind === 'config'
          ? { type: 'configuration', data: chunk.data }
          : { type: 'data', keyframe: chunk.keyframe, data: chunk.data, pts: BigInt(chunk.timestamp) }
      void writer.write(packet).catch(() => {})
    })
    // Video stream ending = the session closed (device unplugged / server stopped); errors likewise.
    call.onEnd(() => lost('Device disconnected'))
    call.onError((e) => lost(e instanceof Error ? e.message : String(e)))

    // ── audio (best-effort; a device with no audio just ends the stream, and any decode error is
    //    swallowed so the mirror keeps running silently) ────────────────────────────────────────
    const audio = new MirrorAudio()
    const audioCall = host.audio({ serial })
    audioCall.onData((chunk: AudioChunk) => {
      if (disposed) return
      if (chunk.kind === 'config') audio.configure(chunk.data)
      else audio.frame(chunk.data, chunk.timestamp)
    })
    audioCall.onError(() => {}) // best-effort — an audio-stream error must never break the mirror
    // Autoplay policy: resume the AudioContext on the first interaction with the window.
    const resumeAudio = (): void => audio.resume()
    window.addEventListener('pointerdown', resumeAudio)

    return () => {
      disposed = true
      window.removeEventListener('pointerdown', resumeAudio)
      control.detach()
      keyboard.detach()
      call.cancel()
      audioCall.cancel()
      audio.close()
      // abort (not close) so any queued/in-flight write is dropped immediately — closing would await
      // the queue and can race decoder.dispose() below.
      void writer.abort().catch(() => {})
      decoder.dispose()
      canvas.remove()
    }
  }, [serial, host, g, attempt])

  // The host (SurfaceWindowRoot) draws the draggable titlebar + close; here we fill with the device
  // screen (canvas appended into screen-holder, which React leaves alone) + React overlays on top.
  return (
    <div className="screen-wrap">
      <div className="screen-holder" ref={screenRef} />
      {!serial ? (
        <p className="msg">No device (props missing)</p>
      ) : phase === 'connecting' ? (
        <p className="msg">Connecting to {serial}…</p>
      ) : phase === 'lost' ? (
        <div className="lost">
          <p className="lost-reason">{reason ?? 'Connection lost'}</p>
          <button className="lost-retry" onClick={() => setAttempt((a) => a + 1)}>
            Reconnect
          </button>
        </div>
      ) : (
        <NavBar client={host} serial={serial} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Mirror />)
