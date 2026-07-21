import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { useHost, useHostEvent, useGarret } from '@garretapp/sdk/react'
import type { Api, Events, AdbDevice, AdbStatus } from '../../shared/api'

function App(): JSX.Element {
  const host = useHost<Api, Events>()
  const g = useGarret()
  const [devices, setDevices] = useState<AdbDevice[]>([])
  const [status, setStatus] = useState<AdbStatus>({ ok: false, state: 'connecting' })

  // Live — the host pushes on every device change (no polling) + on adb-status changes.
  useHostEvent<Events, 'devices:changed'>('devices:changed', setDevices)
  useHostEvent<Events, 'adb:status'>('adb:status', setStatus)
  // Initial snapshot (covers state that landed before this UI mounted its listeners).
  useEffect(() => {
    void host.status().then(setStatus)
    void host.listDevices().then(setDevices)
  }, [host])

  return (
    <div className="wrap">
      {!status.ok ? (
        <div className="msg">
          {status.state === 'connecting' ? (
            'Connecting to adb…'
          ) : (
            <>
              <p className="err">{status.error ?? 'adb unavailable'}</p>
              <button className="retry" onClick={() => void host.retry()}>
                Retry
              </button>
            </>
          )}
        </div>
      ) : devices.length === 0 ? (
        <p className="msg">No devices connected. Connect over USB and enable debugging.</p>
      ) : (
        <ul className="list">
          {devices.map((d) => {
            const label = d.name || d.model || d.product || d.serial
            const online = d.state === 'device'
            return (
              <li key={d.transportId}>
                <button
                  className="row"
                  disabled={!online}
                  title={online ? `Mirror ${label}` : `Device is ${d.state}`}
                  // Open a floating mirror window per device; key=serial → one window per device (a
                  // repeat click focuses the existing one instead of spawning another).
                  onClick={() =>
                    void g.surfaces.open('device-mirror', {
                      key: d.serial,
                      title: label,
                      props: { serial: d.serial, model: label }
                    })
                  }
                >
                  <span className={`dot ${d.state}`} />
                  <span className="info">
                    <span className="name">{label}</span>
                    <span className="serial">{d.serial}</span>
                  </span>
                  {online ? (
                    <span className="play" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  ) : (
                    <span className="state">{d.state}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
