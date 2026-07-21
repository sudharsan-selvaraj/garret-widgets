import { AndroidKeyCode, AndroidKeyEventMeta } from '@yume-chan/scrcpy'

/** The subset of the host client this module drives. */
interface KeyClient {
  key(a: { serial: string; action: 'down' | 'up'; keyCode: number; metaState?: number; repeat?: number }): Promise<void>
  text(a: { serial: string; text: string }): Promise<void>
}

// Bare modifier presses are skipped — metaState on the real key carries them, and injecting the
// modifier keycode alone tends to confuse the device's input dispatcher.
const BARE_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

const metaOf = (e: KeyboardEvent): number => {
  let m = 0
  if (e.shiftKey) m |= AndroidKeyEventMeta.Shift
  if (e.ctrlKey) m |= AndroidKeyEventMeta.Ctrl
  if (e.altKey) m |= AndroidKeyEventMeta.Alt
  if (e.metaKey) m |= AndroidKeyEventMeta.Meta
  return m
}

// The AndroidKeyCode enum names mirror KeyboardEvent.code (KeyA, Digit0, ArrowUp, Enter, Tab, Space,
// Backspace, Escape, Delete, Home, End, PageUp/Down…), so a direct lookup covers most keys.
const keyCodeOf = (code: string): number | undefined => {
  const v = (AndroidKeyCode as unknown as Record<string, number>)[code]
  return typeof v === 'number' ? v : undefined
}

const isTextEntry = (e: KeyboardEvent): boolean => e.key.length === 1 && !e.ctrlKey && !e.metaKey

/**
 * Forward hardware keyboard input to the device. Natural typing (a printable char with no Ctrl/Meta)
 * goes via `injectText`, so layout / shift / capitals are correct without a full keymap; navigation +
 * editing keys and Ctrl/Meta shortcuts go via `injectKeyCode` (down/up with metaState). The two paths
 * are mutually exclusive per keystroke so nothing double-types.
 *
 * Listeners are on `window`, which only sees keys while THIS surface window's guest has focus (clicking
 * the screen focuses it) — so they're naturally scoped to this mirror; removed on `detach`.
 */
export function attachKeyboardControl(client: KeyClient, serial: string): { detach: () => void } {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || BARE_MODIFIERS.has(e.key)) return
    if (isTextEntry(e)) {
      e.preventDefault()
      void client.text({ serial, text: e.key }).catch(() => {})
      return
    }
    const keyCode = keyCodeOf(e.code)
    if (keyCode === undefined) return
    e.preventDefault()
    void client
      .key({ serial, action: 'down', keyCode, metaState: metaOf(e), repeat: e.repeat ? 1 : 0 })
      .catch(() => {})
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.isComposing || BARE_MODIFIERS.has(e.key) || isTextEntry(e)) return // text injected atomically on keydown
    const keyCode = keyCodeOf(e.code)
    if (keyCode === undefined) return
    e.preventDefault()
    void client.key({ serial, action: 'up', keyCode, metaState: metaOf(e) }).catch(() => {})
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  return {
    detach: () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }
}
