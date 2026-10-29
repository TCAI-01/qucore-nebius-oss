import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CircleDashed, Cpu, RefreshCw, Save, SlidersHorizontal, Terminal } from 'lucide-react'
import { api } from '../api.js'
import TavilyCredentials from './TavilyCredentials.jsx'

// Read-only fields the backend adds to GET /settings; never sent back on save.
const READ_ONLY = ['providers', 'active', 'configured', 'active_deployment', 'env_errors', 'nebius_models', 'nebius_embedding_models', 'ui']
const SECRETS = ['nebius_api_key']
const CUSTOM = '__custom__'

function cleanDraft(settings) {
  const fields = Object.fromEntries(Object.entries(settings).filter(([key]) => !READ_ONLY.includes(key) && !key.startsWith('has_')))
  for (const key of SECRETS) { fields[key] = ''; fields[`clear_${key}`] = false }
  return fields
}

export default function SettingsPanel({ settings: initial, onSaved }) {
  const [settings, setSettings] = useState(initial)
  const [draft, setDraft] = useState(() => cleanDraft(initial))
  // Only fields edited here are sent, so values changed by hand in backend/.env
  // are never overwritten by a stale form.
  const [dirty, setDirty] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const nebiusModels = settings.nebius_models || []
  const [customModel, setCustomModel] = useState(() => Boolean(initial.nebius_model) && !(initial.nebius_models || []).some(m => m.id === initial.nebius_model))
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setDirty(current => new Set(current).add(key)); setSaved(false) }
  function load(result) {
    setSettings(result); setDraft(cleanDraft(result)); setDirty(new Set()); onSaved(result)
    setCustomModel(Boolean(result.nebius_model) && !(result.nebius_models || []).some(m => m.id === result.nebius_model))
  }
  async function reload() {
    setError('')
    try { load(await api.settings()) } catch (err) { setError(err.message) }
  }
  useEffect(() => { reload() }, [])  // pick up edits made directly in backend/.env
  const field = (key, label, { type = 'text', placeholder = '', help = '', min, max } = {}) => <div>
    <label className="field-label" htmlFor={`config-${key}`}>{label}</label>
    <input className="input" id={`config-${key}`} type={type} value={draft[key] ?? ''} placeholder={placeholder} min={min} max={max}
      autoComplete={type === 'password' ? 'new-password' : 'off'} onChange={e => change(key, type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
    {help && <p className="field-help">{help}</p>}
  </div>
  const select = (key, label, options, help = '') => <div><label className="field-label" htmlFor={`config-${key}`}>{label}</label><select id={`config-${key}`} className="input" value={draft[key]} onChange={e => change(key, e.target.value)}>{options.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select>{help && <p className="field-help">{help}</p>}</div>
  const secret = (key, label, blankHint) => field(key, label, { type: 'password', placeholder: settings[`has_${key}`] ? 'Saved — leave blank to keep' : blankHint })
  const clearBox = (key, label) => settings[`has_${key}`] && <label className="flex items-center gap-2 text-sm text-muted mt-5"><input type="checkbox" checked={draft[`clear_${key}`]} onChange={e => change(`clear_${key}`, e.target.checked)} />{label}</label>

  async function submit(event) {
    event.preventDefault(); setError(''); setSaved(false)
    const changes = Object.fromEntries([...dirty].map(key => [key, draft[key]]))
    if (!Object.keys(changes).length) { setSaved(true); return }
    setBusy(true)
    try { load(await api.saveSettings(changes)); setSaved(true) }
    catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  const configured = Boolean(settings.providers?.nebius?.configured)

  return <section className="max-w-5xl mx-auto p-6 lg:p-10">
    <p className="eyebrow">Bring your own key · Nebius Token Factory</p><h1 className="page-title">Credentials manager</h1>
    <div className="flex flex-wrap items-start justify-between gap-3 mt-2 mb-7">
      <p className="text-muted text-sm max-w-3xl">Everything saves to <code>backend/.env</code>, and edits made directly in that file show up here after <b>Reload</b>. Only the fields you change are written. API keys stay on the backend and are never returned to this form.</p>
      <button type="button" className="btn" onClick={reload}><RefreshCw size={14} />Reload from .env</button>
    </div>
    {settings.env_errors?.length > 0 && <div role="alert" className="error-box mb-5 flex gap-3"><AlertTriangle size={16} className="shrink-0 mt-0.5" /><div>
      <p className="font-medium">Some values in backend/.env could not be used, so defaults are shown for them. Correct them below and save, or fix the file and reload:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1">{settings.env_errors.map((item, i) => <li key={i}>{item}</li>)}</ul></div></div>}
    <form onSubmit={submit} className="space-y-5">
      <section className="card p-6"><h2 className="section-title mb-2 flex-wrap"><Cpu size={18} />Nebius Token Factory <span className="pill">OpenAI SDK</span>
        <span className="ml-auto text-xs font-normal flex items-center gap-1.5">{configured ? <><CheckCircle2 size={14} className="text-added" />Configured</> : <><CircleDashed size={14} className="text-muted" />Not configured</>}</span></h2>
        <p className="text-xs text-muted mb-5">Bring your own key: every model call (NVIDIA Nemotron chat models and the fixed Qwen/Qwen3-Embedding-8B embedding model) goes to the Nebius Token Factory OpenAI-compatible API with <code>OpenAI(base_url, api_key)</code>. Any model ID your endpoint serves works. Fallback prices: <code>NEBIUS_INPUT_COST_PER_MILLION</code> / <code>NEBIUS_OUTPUT_COST_PER_MILLION</code> in backend/.env.</p>
        <div className="grid md:grid-cols-2 gap-5">
          <div className="md:col-span-2">{field('nebius_endpoint', 'Base URL', { placeholder: 'https://api.tokenfactory.us-central1.nebius.com/v1/', help: 'The Token Factory API base ending in /v1 (a pasted …/chat/completions URL is trimmed).' })}</div>
          {secret('nebius_api_key', 'API key (NEBIUS_API_KEY)', 'Paste your Nebius API key')}
          {select('nebius_chat_token_parameter', 'Output token parameter', [['max_tokens', 'max_tokens (recommended)'], ['max_completion_tokens', 'max_completion_tokens']])}
          <div>
            <label className="field-label" htmlFor="config-nebius-model-pick">Nemotron model</label>
            <select id="config-nebius-model-pick" className="input"
              value={customModel ? CUSTOM : (nebiusModels.some(m => m.id === draft.nebius_model) ? draft.nebius_model : (draft.nebius_model ? CUSTOM : ''))}
              onChange={e => { if (e.target.value === CUSTOM) { setCustomModel(true) } else { setCustomModel(false); change('nebius_model', e.target.value) } }}>
              {!draft.nebius_model && <option value="">Choose a model…</option>}
              {nebiusModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              <option value={CUSTOM}>Custom model ID…</option>
            </select>
            <p className="field-help">{nebiusModels.find(m => m.id === draft.nebius_model)?.note || 'Any model ID from your Token Factory console.'}</p>
          </div>
          <div>
            <label className="field-label" htmlFor="config-nebius_model">Model ID</label>
            <input id="config-nebius_model" className="input font-mono text-xs" value={draft.nebius_model ?? ''} readOnly={!customModel}
              placeholder="e.g. nvidia/Nemotron-3-Ultra-550b-a55b" onChange={e => change('nebius_model', e.target.value)} />
            <p className="field-help">{customModel ? 'Type the exact model ID.' : 'Choose "Custom model ID…" to type another.'}</p>
          </div>
        </div>
        {clearBox('nebius_api_key', 'Remove the saved Nebius key on save')}
      </section>

      <section className="card p-6"><h2 className="section-title mb-2"><Terminal size={18} />Code sandbox <span className="pill">QuSolids</span></h2>
        <p className="text-xs text-muted mb-5">Runs QuSolids demonstrations remotely in the Nebius sandbox, never on this computer: <code>ContreeSync().images.use("python:3.12").run("python", args=["-c", code]).wait()</code> using <code>NEBIUS_API_KEY</code> and <code>NEBIUS_PROJECT_ID</code>.</p>
        <div className="grid md:grid-cols-2 gap-5">
          <div>
            <label className="field-label" htmlFor="config-sandbox-nebius-key">Nebius API key (NEBIUS_API_KEY)</label>
            <input className="input" id="config-sandbox-nebius-key" type="password" autoComplete="new-password" value={draft.nebius_api_key ?? ''}
              placeholder={settings.has_nebius_api_key ? 'Saved — leave blank to keep' : 'Paste your Nebius API key'} onChange={e => change('nebius_api_key', e.target.value)} />
            <p className="field-help">The same key as in the Nebius Token Factory section.</p>
          </div>
          {field('nebius_project_id', 'Nebius project ID (NEBIUS_PROJECT_ID)', { placeholder: 'e.g. project-e00abc123…', mono: false, help: 'The project that owns your Nebius sandbox.' })}
        </div>
      </section>

      <TavilyCredentials />

      <section className="card p-6"><h2 className="section-title mb-5"><SlidersHorizontal size={18} />Context and output limits</h2>
        <div className="grid md:grid-cols-2 gap-5">
          {field('context_window', 'Model context window (NEBIUS_CONTEXT_WINDOW)', { type: 'number', min: 8192, max: 2000000, help: "Set the chosen model's documented window. Input size is checked before any model call." })}
          {field('max_output_tokens', 'Maximum output tokens (NEBIUS_MAX_OUTPUT_TOKENS)', { type: 'number', min: 1024, max: 128000, help: 'For reasoning models, this budget also covers reasoning tokens.' })}
        </div>
      </section>
      {error && <p role="alert" className="error-box">{error}</p>}
      <div className="flex items-center gap-4 sticky bottom-0 bg-ink/90 backdrop-blur-sm py-3"><button className="btn-primary" disabled={busy}><Save size={16} />{busy ? 'Saving…' : `Save credentials${dirty.size ? ` (${dirty.size} change${dirty.size === 1 ? '' : 's'})` : ''}`}</button>{saved && <p role="status" className="text-added text-sm">Saved to backend/.env. No connection test was run.</p>}</div>
      <p className="text-xs text-muted">Comments and other lines in backend/.env are kept exactly as they are; only the changed values are rewritten.</p>
    </form>
  </section>
}
