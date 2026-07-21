import { Adb, type AdbServerClient } from '@yume-chan/adb'

// Marketing-name props by OEM (most-specific first), then fall back to the model. Different vendors
// stash the consumer name in different keys; the adb device list only carries the codename/model.
const MARKET_KEYS = [
  'ro.product.marketname', // Pixel + many OEMs
  'ro.vendor.oplus.market.name', // OnePlus / Oppo / Realme
  'ro.config.marketing_name', // Samsung
  'ro.product.vendor.marketname',
  'ro.product.odm.marketname'
]

const titleCase = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase())

/** Prepend the manufacturer unless the name already leads with it (avoids "OnePlus OnePlus Nord"). */
const withManufacturer = (name: string, manufacturer: string): string =>
  manufacturer && !name.toLowerCase().startsWith(manufacturer.toLowerCase()) ? `${manufacturer} ${name}` : name

/**
 * Resolve a human device name (e.g. "OnePlus Nord 5", "Samsung Galaxy S21") from device props.
 * Best-effort: any failure returns null and the UI falls back to the adb model/serial. Opens a
 * short-lived transport, reads props, closes it — callers should cache the result per serial.
 */
export async function resolveDeviceName(client: AdbServerClient, serial: string): Promise<string | null> {
  let adb: Adb | null = null
  try {
    adb = new Adb(await client.createTransport({ serial }))
    const get = async (k: string): Promise<string> => (await adb!.getProp(k)).trim()

    let market = ''
    for (const k of MARKET_KEYS) {
      market = await get(k)
      if (market) break
    }
    const manufacturer = titleCase((await get('ro.product.manufacturer')).toLowerCase())
    if (market) return withManufacturer(market, manufacturer)

    const model = await get('ro.product.model')
    // Emulators carry no market name and an sdk_* model — give them a friendly label too.
    if (serial.startsWith('emulator-') || /(^sdk_|_sdk|emulator)/i.test(model)) return 'Android Emulator'
    return model ? withManufacturer(model, manufacturer) : null
  } catch {
    return null
  } finally {
    await adb?.close().catch(() => {})
  }
}
