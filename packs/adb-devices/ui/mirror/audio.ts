/**
 * Opus → speakers. scrcpy sends one `config` packet (the OpusHead) then Opus `frame`s; we decode with
 * WebCodecs `AudioDecoder` and schedule the PCM into a Web Audio graph with a small lead so playback
 * is gapless. Deliberately best-effort: any decode/config failure is swallowed (a phone mirror must
 * never break because audio hiccuped) and it no-ops on devices with no audio (Android <11 / emulator,
 * where the audio stream ends before any config arrives — so we never even open an AudioContext).
 */
// A/V sync: the video decoder draws frames immediately (and drops to stay realtime), so video is
// ~live. Audio must track it. We keep a small scheduling lead to absorb IPC/decode jitter, but if the
// lead grows past MAX_LEAD — a startup burst or buffered packets — audio is lagging the video, so we
// DROP frames to catch up (a one-time content skip, seamless in the schedule timeline) rather than
// queue them further into the future.
const LEAD = 0.05 // seconds ahead of the audio clock we aim to schedule
const MAX_LEAD = 0.15 // seconds; beyond this the audio is backed up behind the (realtime) video

export class MirrorAudio {
  #ctx: AudioContext | null = null
  #decoder: AudioDecoder | null = null
  #playAt = 0 // AudioContext-clock time the next buffer should start at (gapless scheduling cursor)
  #baseTs: number | null = null // first packet pts, so decode timestamps start near 0 and stay monotonic
  #configured = false
  #closed = false

  /** Called on the scrcpy `config` (OpusHead) packet — sets up the decoder + audio graph. */
  configure(description?: Uint8Array): void {
    if (this.#closed || this.#configured) return
    if (typeof AudioDecoder === 'undefined' || typeof AudioContext === 'undefined') return
    const ctx = new AudioContext({ sampleRate: 48000 }) // scrcpy Opus is always 48kHz
    void ctx.resume().catch(() => {})
    const decoder = new AudioDecoder({
      output: (data) => this.#render(data),
      error: () => {} // best-effort: a decode error must not tear down the mirror
    })
    const base: AudioDecoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }
    try {
      decoder.configure(description?.byteLength ? { ...base, description } : base)
    } catch {
      try {
        decoder.configure(base) // retry without the OpusHead description
      } catch {
        void ctx.close().catch(() => {})
        return
      }
    }
    this.#ctx = ctx
    this.#decoder = decoder
    this.#configured = true
  }

  /** Called on each Opus `frame` packet. */
  frame(data: Uint8Array, timestamp: number): void {
    const d = this.#decoder
    if (!d || this.#closed || d.state !== 'configured') return
    if (this.#baseTs === null) this.#baseTs = timestamp
    try {
      d.decode(
        new EncodedAudioChunk({
          type: 'key', // every Opus packet is independently decodable
          timestamp: Math.max(0, timestamp - this.#baseTs),
          data
        })
      )
    } catch {
      /* best-effort */
    }
  }

  /** AudioContext can start suspended until a user gesture — call from a UI interaction handler. */
  resume(): void {
    void this.#ctx?.resume().catch(() => {})
  }

  close(): void {
    this.#closed = true
    try {
      this.#decoder?.close()
    } catch {
      /* already closed */
    }
    void this.#ctx?.close().catch(() => {})
    this.#decoder = null
    this.#ctx = null
  }

  #render(data: AudioData): void {
    const ctx = this.#ctx
    if (!ctx || this.#closed) {
      data.close()
      return
    }
    try {
      const now = ctx.currentTime
      // Backed up behind the realtime video → drop this frame to catch up (don't advance the cursor,
      // so the already-scheduled audio plays out seamlessly and new frames resume once we're in range).
      if (this.#playAt > now + MAX_LEAD) return
      const channels = data.numberOfChannels
      const frames = data.numberOfFrames
      const buffer = ctx.createBuffer(channels, frames, data.sampleRate)
      const plane = new Float32Array(frames)
      for (let c = 0; c < channels; c++) {
        // Force planar float so `planeIndex` selects a single channel regardless of the source layout.
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
        buffer.copyToChannel(plane, c)
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      // Underrun / first packet → resync with a small lead.
      if (this.#playAt < now) this.#playAt = now + LEAD
      src.start(this.#playAt)
      this.#playAt += buffer.duration
    } catch {
      /* best-effort */
    } finally {
      data.close()
    }
  }
}
