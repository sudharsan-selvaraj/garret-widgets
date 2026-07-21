import type { ReadableStream } from '@yume-chan/stream-extra'
import type { ScrcpyControlMessageWriter, ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy'
import { toVideoChunk, toAudioChunk, type MirrorSession } from './mirror'
import type { VideoChunk, AudioChunk } from '../../shared/api'

/**
 * A mirror session HUB. scrcpy multiplexes video + audio over one connection and ya-webadb warns that
 * BOTH parsed streams must be consumed or the shared parser blocks (a video-only UI would stall).
 * So the hub drains both device streams immediately — independent of whether the UI has subscribed —
 * and fans packets out to subscribers (dropping when none). It ref-counts subscribers and calls
 * `onEmpty` when the last one leaves (or on open failure) so the host can close + reset the session,
 * fixing both the stall and the cancel-leak/poisoned-session bugs.
 */
export interface Sink<C> {
  push(chunk: C): void
  end(): void
  error(err: unknown): void
}
export interface MirrorHub {
  subscribeVideo(sink: Sink<VideoChunk>): () => void
  subscribeAudio(sink: Sink<AudioChunk>): () => void
  /** Run `fn` against the live control writer (input injection). Best-effort: no-ops if the session
   *  isn't open / has no control channel / is closed, and swallows write errors (the writer is
   *  released when the hub closes, so a racing input must never throw or tear anything down). */
  control(fn: (c: ScrcpyControlMessageWriter) => Promise<void>): Promise<void>
  close(): Promise<void>
}

export function createHub(open: () => Promise<MirrorSession>, onEmpty: () => void): MirrorHub {
  const videoSinks = new Set<Sink<VideoChunk>>()
  const audioSinks = new Set<Sink<AudioChunk>>()
  let meta: (VideoChunk & { kind: 'meta' }) | null = null
  let failed: unknown = null
  let closed = false
  let controlChain: Promise<void> = Promise.resolve() // serializes control writes (ordering + no interleave)

  const refDroppedToZero = (): void => {
    if (videoSinks.size === 0 && audioSinks.size === 0) onEmpty()
  }

  const sessionP = open()
  void sessionP
    .then((s) => {
      meta = { kind: 'meta', ...s.meta }
      for (const v of videoSinks) v.push(meta)
      // Drain video (always — even with no sink — to keep the connection flowing).
      void drain(s.video, toVideoChunk, videoSinks)
      // Drain audio if present; otherwise end audio sinks immediately (Android <11).
      if (s.audio) void drain(s.audio, toAudioChunk, audioSinks)
      else for (const a of audioSinks) a.end()
    })
    .catch((e) => {
      failed = e
      for (const v of videoSinks) v.error(e)
      for (const a of audioSinks) a.error(e)
      onEmpty() // poisoned → host nulls the hub so a later subscribe re-opens
    })

  async function drain<C>(
    stream: ReadableStream<ScrcpyMediaStreamPacket>,
    map: (p: ScrcpyMediaStreamPacket) => C,
    sinks: Set<Sink<C>>
  ): Promise<void> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = map(value)
        for (const s of sinks) s.push(chunk)
      }
      for (const s of sinks) s.end()
    } catch (e) {
      for (const s of sinks) s.error(e)
    }
  }

  return {
    subscribeVideo(sink) {
      if (failed) {
        sink.error(failed)
        return () => {}
      }
      if (meta) sink.push(meta)
      videoSinks.add(sink)
      return () => {
        videoSinks.delete(sink)
        refDroppedToZero()
      }
    },
    subscribeAudio(sink) {
      if (failed) {
        sink.error(failed)
        return () => {}
      }
      audioSinks.add(sink)
      return () => {
        audioSinks.delete(sink)
        refDroppedToZero()
      }
    },
    control(fn) {
      // Serialize ALL control writes: down/up (and moves) arrive as separate async host calls, so
      // without a mutex their injectTouch writes can interleave/reorder on the shared control stream —
      // Android then sees up-before-down and the tap lands a click late. Chain each fn after the last.
      const run = controlChain.then(async () => {
        if (closed || failed) return
        let session: MirrorSession
        try {
          session = await sessionP
        } catch {
          return // open failed
        }
        if (closed || !session.controller) return
        try {
          await fn(session.controller)
        } catch {
          /* best-effort — the writer may have been released by a concurrent close */
        }
      })
      controlChain = run.catch(() => {}) // keep the chain alive even if one fn rejects
      return run
    },
    async close() {
      if (closed) return
      closed = true
      try {
        await (await sessionP).close()
      } catch {
        /* already gone / never opened */
      }
    }
  }
}
