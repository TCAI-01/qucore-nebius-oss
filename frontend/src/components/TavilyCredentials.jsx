import { useEffect, useState } from 'react'
import { CheckCircle2, CircleDashed, Globe, LoaderCircle, Save, Trash2 } from 'lucide-react'
import { api } from '../api.js'

// Credentials > Tavily web search (used by QuScan). Saves TAVILY_API_KEY in backend/.env; the key is never sent back.
export default function TavilyCredentials() {
  const [info, setInfo] = useState(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { api.quscanCredentials().then(setInfo).catch(err => setError(err.message)) }, [])

  async function save(clear = false) {
    setBusy(true); setError(''); setMessage('')
    try {
      const next = await api.quscanSaveCredentials(clear ? { clear: true } : { api_key: key.trim() })
      setInfo(next); setKey('')
      setMessage(clear ? 'Removed from backend/.env.' : 'Saved to backend/.env. No connection test was run.')
      window.dispatchEvent(new Event('quscan-credentials'))
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return <section className="card p-6">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
      <h2 className="section-title"><Globe size={18} />Tavily web search <span className="pill">QuScan</span></h2>
      {info && (info.has_tavily_api_key
        ? <span className="flex items-center gap-1.5 text-xs text-added"><CheckCircle2 size={14} />Saved {info.hint && <code>{info.hint}</code>}</span>
        : <span className="flex items-center gap-1.5 text-xs text-muted"><CircleDashed size={14} />Not configured</span>)}
    </div>
    <p className="text-xs text-muted mb-5">QuScan uses <code>TavilyClient(api_key).search / extract / crawl</code> to find advisories, CVEs and threat news. Get a key at tavily.com.
      {info && !info.sdk_installed && <> The <code>tavily-python</code> package is not installed; QuScan calls the Tavily REST API directly instead.</>}</p>
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[260px]">
        <label className="field-label" htmlFor="config-tavily">API key</label>
        <input id="config-tavily" className="input" type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)}
          placeholder={info?.has_tavily_api_key ? 'Saved — paste a new key to replace it' : 'tvly-…'} />
      </div>
      <button type="button" className="btn-primary" disabled={busy || !key.trim()} onClick={() => save(false)}>
        {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}Save Tavily key</button>
      {info?.has_tavily_api_key && <button type="button" className="btn" disabled={busy} onClick={() => save(true)}><Trash2 size={15} />Remove</button>}
    </div>
    {message && <p role="status" className="text-added text-sm mt-3">{message}</p>}
    {error && <p role="alert" className="error-box mt-3">{error}</p>}
  </section>
}
