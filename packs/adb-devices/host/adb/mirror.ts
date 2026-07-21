import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Adb, type AdbServerClient } from '@yume-chan/adb'
import { AdbScrcpyClient, AdbScrcpyOptions3_3_1 } from '@yume-chan/adb-scrcpy'
import { DefaultServerPath, type ScrcpyControlMessageWriter, type ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy'
import { ReadableStream } from '@yume-chan/stream-extra'
import type { VideoChunk, AudioChunk, MirrorConfig } from '../../shared/api'

// The scrcpy server (a ~90KB .jar) runs ON the device via app_process. It VERIFIES the version arg it's
// launched with equals its own — so the vendored jar (see build.mjs) and this string must match.
// scrcpy 3.3.1 is required for modern Android (2.x fails on Android 14+: SurfaceControl.createDisplay
// was removed — verified live against an Android 16 device). The option-class family (3_3_1) must also
// match the server line. See package.json "comment".
const SCRCPY_VERSION = '3.3.1'

/** The bundled scrcpy-server jar, copied next to the built host (dist/host/) by build.mjs. */
async function serverJarStream(): Promise<ReadableStream<Uint8Array>> {
  const bytes = await readFile(join(__dirname, 'scrcpy-server.jar'))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes))
      controller.close()
    }
  })
}

const toVideoChunk = (p: ScrcpyMediaStreamPacket): VideoChunk =>
  p.type === 'configuration'
    ? { kind: 'config', data: p.data }
    : { kind: 'frame', data: p.data, keyframe: p.keyframe ?? false, timestamp: Number(p.pts ?? 0) }

const toAudioChunk = (p: ScrcpyMediaStreamPacket): AudioChunk =>
  p.type === 'configuration'
    ? { kind: 'config', data: p.data }
    : { kind: 'frame', data: p.data, timestamp: Number(p.pts ?? 0) }

/** One live scrcpy session for a device: parsed video + (optional) audio packet streams + control. */
export interface MirrorSession {
  meta: { width: number; height: number; videoCodec: string; audioCodec: string | null }
  video: ReadableStream<ScrcpyMediaStreamPacket>
  audio: ReadableStream<ScrcpyMediaStreamPacket> | null
  controller: ScrcpyControlMessageWriter | undefined
  close(): Promise<void>
}

/**
 * Push the scrcpy server to the device and start a session: H.264 video + Opus audio (Android 11+)
 * + a control channel. `serverClient.createTransport` gives a device-level `Adb`; the session lives
 * until `close()` (which stops the on-device server + closes the adb connection).
 */
export async function openMirror(
  serverClient: AdbServerClient,
  serial: string,
  cfg: MirrorConfig
): Promise<MirrorSession> {
  const adb = new Adb(await serverClient.createTransport({ serial }))
  // Once the on-device scrcpy server is started, ANY later failure (no video stream, etc.) must tear
  // it down — otherwise app_process keeps running on the device (holding the display) after we bail.
  let client: Awaited<ReturnType<typeof AdbScrcpyClient.start>> | undefined
  try {
    await AdbScrcpyClient.pushServer(adb, await serverJarStream())

    const options = new AdbScrcpyOptions3_3_1(
      {
        video: true,
        audio: true,
        control: true,
        videoCodec: 'h264',
        audioCodec: 'opus',
        videoBitRate: cfg.videoBitRate ?? 8_000_000,
        maxFps: cfg.maxFps ?? 60,
        maxSize: cfg.maxSize ?? 0
      },
      { version: SCRCPY_VERSION }
    )

    client = await AdbScrcpyClient.start(adb, DefaultServerPath, options)
    const videoStream = await client.videoStream
    if (!videoStream) throw new Error('scrcpy started without a video stream')

    let audio: ReadableStream<ScrcpyMediaStreamPacket> | null = null
    const audioMeta = await client.audioStream // undefined on <2.0; disabled/errored otherwise
    if (audioMeta && audioMeta.type === 'success') audio = audioMeta.stream

    const started = client
    // We request h264 + opus explicitly, so the codecs are known (avoids mapping ya-webadb's enums).
    return {
      meta: { width: videoStream.width, height: videoStream.height, videoCodec: 'h264', audioCodec: audio ? 'opus' : null },
      video: videoStream.stream,
      audio,
      controller: started.controller,
      close: async () => {
        await started.close()
        await adb.close()
      }
    }
  } catch (e) {
    await client?.close().catch(() => {})
    await adb.close().catch(() => {})
    throw e
  }
}

export { toVideoChunk, toAudioChunk }
