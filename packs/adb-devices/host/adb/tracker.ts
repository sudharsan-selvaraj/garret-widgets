import type { AdbServerClient } from '@yume-chan/adb'
import type { AdbDevice } from '../../shared/api'

/** ya-webadb Device (bigint transportId) → the wire-safe AdbDevice. */
export function toAdbDevice(d: AdbServerClient.Device): AdbDevice {
  return {
    serial: d.serial,
    state: d.state,
    product: d.product,
    model: d.model,
    device: d.device,
    transportId: String(d.transportId)
  }
}

/**
 * Live device tracking — `trackDevices` opens adb's `host:track-devices` push socket, so the observer
 * fires on every plug/unplug/authorize with NO polling. `onList` gets the full current list each time.
 * Returns the observer so the caller can `.stop()` it on dispose.
 */
export async function startTracker(
  client: AdbServerClient,
  onList: (devices: AdbDevice[]) => void
): Promise<AdbServerClient.DeviceObserver> {
  const observer = await client.trackDevices()
  onList(observer.current.map(toAdbDevice))
  observer.onListChange((list) => onList(list.map(toAdbDevice)))
  return observer
}
