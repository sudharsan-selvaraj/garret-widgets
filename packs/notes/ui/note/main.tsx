import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useGarret } from '@garretapp/sdk/react'
import './note.css'

// Notes — a per-placement scratchpad that autosaves. Pure UI, no capabilities: the text lives in the
// widget's own isolated per-instance storage (each placed note is independent). Migrated from the
// built-in `notes` widget as the first built-in→pack pilot.
function App(): JSX.Element {
  const g = useGarret()
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)

  // Load this placement's saved note.
  useEffect(() => {
    void g.instanceStorage.get<string>('text').then((v) => {
      setText(v ?? '')
      setLoaded(true)
    })
  }, [g])

  // Debounced autosave back to per-instance storage.
  useEffect(() => {
    if (!loaded) return
    const id = setTimeout(() => void g.instanceStorage.set('text', text), 400)
    return () => clearTimeout(id)
  }, [text, loaded, g])

  return (
    <textarea
      id="pad"
      value={text}
      placeholder="Jot something…"
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
    />
  )
}

createRoot(document.getElementById('root')!).render(<App />)
