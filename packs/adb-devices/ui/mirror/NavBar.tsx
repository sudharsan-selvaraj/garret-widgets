import type { DeviceAction } from '../../shared/api'

/** Width (px) of the vertical control column. MUST match `.navbar-v` in index.html and the aspect
 *  inset the mirror passes to `g.window.setAspectRatio` so the device area stays correctly sized. */
export const NAVBAR_W = 48

/** The subset of the host client this component drives. */
interface ActionClient {
  action(a: { serial: string; kind: DeviceAction }): Promise<void>
}

// lucide-style 18px stroke icons (currentColor); inline so the guest bundle needs no icon dep.
const Icon = ({ d }: { d: string }): JSX.Element => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)
const BackIcon = <Icon d="M19 12H5M12 19l-7-7 7-7" />
const HomeIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="12" cy="12" r="9" /></svg>
)
const RecentsIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="4" y="4" width="16" height="16" rx="2.5" /></svg>
)
const PowerIcon = <Icon d="M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0" />
const VolUpIcon = <Icon d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
const VolDownIcon = <Icon d="M11 5 6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" />
const RotateIcon = <Icon d="M23 4v6h-6M20.5 15a9 9 0 1 1-2.1-9.4L23 10" />
const BellIcon = <Icon d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />

const PRIMARY: { kind: DeviceAction; label: string; icon: JSX.Element }[] = [
  { kind: 'back', label: 'Back', icon: BackIcon },
  { kind: 'home', label: 'Home', icon: HomeIcon },
  { kind: 'appSwitch', label: 'Recent apps', icon: RecentsIcon }
]
const SYSTEM: { kind: DeviceAction; label: string; icon: JSX.Element }[] = [
  { kind: 'notifications', label: 'Notifications', icon: BellIcon },
  { kind: 'volumeUp', label: 'Volume up', icon: VolUpIcon },
  { kind: 'volumeDown', label: 'Volume down', icon: VolDownIcon },
  { kind: 'rotate', label: 'Rotate', icon: RotateIcon },
  { kind: 'power', label: 'Power', icon: PowerIcon }
]

/**
 * Always-visible vertical control column beside the device (the host reserves NAVBAR_W via the aspect
 * inset, so it never overlays the screen). Android nav trio on top, a divider, then system actions —
 * all driving the host `action` channel.
 */
export function NavBar({ client, serial }: { client: ActionClient; serial: string }): JSX.Element {
  const act = (kind: DeviceAction) => (): void => {
    void client.action({ serial, kind }).catch(() => {})
  }
  const btn = (b: { kind: DeviceAction; label: string; icon: JSX.Element }): JSX.Element => (
    <button key={b.kind} className="nav-btn" title={b.label} aria-label={b.label} onClick={act(b.kind)}>
      {b.icon}
    </button>
  )
  return (
    <div className="navbar-v">
      {PRIMARY.map(btn)}
      <div className="nav-sep" />
      {SYSTEM.map(btn)}
    </div>
  )
}
