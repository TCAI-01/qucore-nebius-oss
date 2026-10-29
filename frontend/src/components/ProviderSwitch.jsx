import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, Settings2 } from 'lucide-react'
import { api } from '../api.js'

// Header switch: the Nemotron model on Nebius Token Factory. Writes NEBIUS_MODEL in backend/.env;
// the key and other settings are managed in Credentials.
export default function ProviderSwitch({ settings, busy, onChange, onError, onConfigure }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const close = event => { if (ref.current && !ref.current.contains(event.target)) setOpen(false) }
    const escape = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [])
  const provider = settings.providers?.nebius || {}
  const nebiusModels = settings.nebius_models || []

  async function chooseModel(model) {
    if (model === settings.nebius_model) { setOpen(false); return }
    setSaving(true)
    try { onChange(await api.setModel(model)); setOpen(false) }
    catch (err) { onError(err.message) }
    finally { setSaving(false) }
  }

  return <div className="relative" ref={ref}>
    <button className="provider-switch" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}
      disabled={saving} title={busy ? 'A review is running; switch after it finishes' : 'Nemotron model on Nebius Token Factory'}>
      <span className={`w-1.5 h-1.5 rounded-full ${settings.configured ? 'bg-added' : 'bg-amber'}`} />
      <Cpu size={14} className="text-sky-400" />
      <span className="hidden sm:flex flex-col items-start leading-tight">
        <span className="text-[10px] text-muted">{provider.label || 'Nebius Token Factory'}</span>
        <span className="text-xs font-medium max-w-[180px] truncate">{settings.configured ? settings.active_deployment : 'Not configured'}</span>
      </span>
      <ChevronDown size={14} className="text-muted" />
    </button>
    {open && <div className="absolute right-0 mt-2 w-80 card shadow-xl z-50 p-1.5" role="listbox" aria-label="Nemotron model">
      {!settings.configured && <button onClick={() => { setOpen(false); onConfigure() }}
        className="w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-elevated">
        <Cpu size={16} className="text-sky-400 mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Nebius Token Factory</span>
          <span className="block text-xs text-muted truncate">Add your Nebius API key to use</span>
        </span>
        <span className="pill">Set up</span>
      </button>}
      {settings.configured && nebiusModels.map(model => {
        const on = settings.nebius_model === model.id
        return <button key={model.id} role="option" aria-selected={on} disabled={busy || saving} onClick={() => chooseModel(model.id)}
          className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-elevated disabled:opacity-50">
          <span className="flex-1 min-w-0">
            <span className="block truncate font-medium">{model.label}</span>
            {model.note && <span className="block truncate text-[11px] text-muted">{model.note}</span>}
          </span>
          {on && <Check size={13} className="text-added" />}
        </button>
      })}
      <div className="border-t border-line mt-1 pt-1">
        <button onClick={() => { setOpen(false); onConfigure() }} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted hover:bg-elevated hover:text-fg">
          <Settings2 size={14} />Manage credentials
        </button>
      </div>
      {busy && <p className="text-[11px] text-amber px-3 pb-2">A review is running. Switch after it finishes.</p>}
    </div>}
  </div>
}
