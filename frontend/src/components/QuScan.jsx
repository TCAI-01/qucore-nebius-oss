import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Bell, Check, ChevronDown, ChevronRight, ClipboardCopy, ExternalLink, FileJson, FileSpreadsheet, FileText,
  History, KeyRound, Layers, Plus, LoaderCircle, Newspaper, Package, Play, RefreshCw, ScanSearch, Search, ShieldAlert, ShieldCheck,
  Square, Trash2,
} from 'lucide-react'
import { api, quscanDownloadUrl } from '../api.js'
import useRunStop from '../useRunStop.js'
import WorkspacePicker from './WorkspacePicker.jsx'
import { ScoreRing, StackedBar } from './SolidCharts.jsx'
import './QuScan.css'

const ECO = { pypi: 'PyPI', npm: 'npm' }
const SEV = ['critical', 'high', 'medium', 'low', 'none']
const SEV_COLOR = { critical: '#e5484d', high: '#f07a3a', medium: '#e0a43a', low: '#3b9bf0', none: '#8b91a7' }
const STATUS = {
  vulnerable: { label: 'Vulnerable', tone: 'bad' }, at_risk: { label: 'At risk', tone: 'warn' }, unknown: { label: 'No verdict', tone: 'muted' },
  safe: { label: 'Safe', tone: 'ok' }, clear: { label: 'No known issues', tone: 'clear' }, not_scanned: { label: 'Not scanned', tone: 'off' },
}
const MODES = [
  { id: 'full', icon: ScanSearch, title: 'Full scan', text: 'Selected packages + today’s threat briefing' },
  { id: 'packages', icon: Package, title: 'Packages', text: 'CVEs, compromised releases and safe versions' },
  { id: 'briefing', icon: Newspaper, title: 'Threat briefing', text: 'Latest CVEs, malware and attacks for your stack' },
]
const WINDOWS = [['day', 'Last 24 hours'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'Last year']]
const DEFAULT_PICK = 40
const DEFAULT_OPTS = { mode: 'full', depth: 'basic', time_range: 'week', results: 5, opencve: true, supply_chain: true, deep_crawl: false, focus: '' }
const isActive = status => ['queued', 'running'].includes(status)
const fmt = value => Number(value || 0).toLocaleString()
const usd = value => (value == null ? '—' : `$${Number(value).toFixed(value >= 1 ? 2 : 4)}`)
const summary = job => ({ id: job.id, kind: job.kind, status: job.status, stage: job.stage, created_at: job.created_at, title: job.title, counts: job.counts, error: job.error })

function usePolling(id, load, onUpdate) {
  useEffect(() => {
    if (!id) return undefined
    let stopped = false
    let timer
    async function poll() {
      try {
        const next = await load(id)
        if (stopped) return
        onUpdate(next)
        if (!isActive(next.status)) return
      } catch { /* retried below */ }
      if (!stopped) timer = setTimeout(poll, 1200)
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
}

function Copy({ text, label = 'Copy', small = true }) {
  const [done, setDone] = useState(false)
  return <button type="button" className={small ? 'btn-small' : 'btn'} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400) } catch { /* blocked */ }
  }}>{done ? <Check size={12} /> : <ClipboardCopy size={12} />}{done ? 'Copied' : label}</button>
}

function StatusPill({ status }) {
  const s = STATUS[status] || STATUS.unknown
  return <span className={`qs-status qs-${s.tone}`}>{s.label}</span>
}

function SevPill({ severity }) {
  if (!severity || severity === 'none') return <span className="qs-sev qs-sev-none">none</span>
  return <span className="qs-sev" style={{ '--sev': SEV_COLOR[severity] }}>{severity}</span>
}

// Text with [n] citations turned into links to the numbered sources.
function Cited({ text, sources = [] }) {
  return String(text || '').split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part)
    const src = m && sources[Number(m[1]) - 1]
    return src ? <a key={i} className="qs-cite" href={src.url} target="_blank" rel="noreferrer" title={src.title}>{m[1]}</a> : <Fragment key={i}>{part}</Fragment>
  })
}

function Favicon({ src }) {
  const [ok, setOk] = useState(Boolean(src?.favicon))
  return ok ? <img className="qs-fav" src={src.favicon} alt="" onError={() => setOk(false)} /> : <span className="qs-fav qs-fav-blank">{(src?.domain || '?')[0]}</span>
}

function Sources({ sources = [] }) {
  if (!sources.length) return null
  return <ol className="qs-sources">{sources.map((s, i) => <li key={s.url + i}>
    <span className="qs-src-n">{i + 1}</span><Favicon src={s} />
    <a href={s.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{s.title || s.domain}</span>
      <span className="block truncate text-[10.5px] text-muted">{s.domain}{s.published_date ? ` · ${String(s.published_date).slice(0, 16)}` : ''}</span></a>
    <ExternalLink size={12} className="text-muted shrink-0" />
  </li>)}</ol>
}

export default function QuScan({ workspace, onWorkspace, settings, onError, onConfigure }) {
  const [creds, setCreds] = useState(null)
  const [inventory, setInventory] = useState(null)
  const [invBusy, setInvBusy] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [query, setQuery] = useState('')
  const [eco, setEco] = useState('all')
  const [directOnly, setDirectOnly] = useState(false)
  const [opts, setOpts] = useState(DEFAULT_OPTS)
  const [history, setHistory] = useState([])
  const [job, setJob] = useState(null)
  const [runningId, setRunningId] = useState(null)
  const [launching, setLaunching] = useState(false)
  const runStop = useRunStop(runningId, launching, api.quscanStop, onError)
  const set = (key, value) => setOpts(current => ({ ...current, [key]: value }))

  const loadCreds = () => api.quscanCredentials().then(setCreds).catch(() => {})
  useEffect(() => {
    loadCreds()
    const again = () => loadCreds()
    window.addEventListener('quscan-credentials', again)
    window.addEventListener('focus', again)
    return () => { window.removeEventListener('quscan-credentials', again); window.removeEventListener('focus', again) }
  }, [])

  async function loadInventory() {
    if (!workspace) { setInventory(null); return }
    setInvBusy(true)
    try {
      const inv = await api.quscanInventory(workspace.id)
      setInventory(inv)
      const direct = inv.packages.filter(p => p.direct)
      setSelected(new Set((direct.length ? direct : inv.packages).slice(0, DEFAULT_PICK).map(p => p.key)))
    } catch (err) { onError(err.message) } finally { setInvBusy(false) }
  }
  useEffect(() => { loadInventory() }, [workspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.quscanJobs().then(items => {
      setHistory(items)
      const running = items.find(item => isActive(item.status))
      if (running) api.quscanJob(running.id).then(next => { setJob(next); setRunningId(next.id) }).catch(() => {})
      else if (items[0]) api.quscanJob(items[0].id).then(setJob).catch(() => {})
    }).catch(() => {})
  }, [])

  usePolling(runningId, api.quscanJob, next => {
    setJob(current => (!current || current.id === next.id ? next : current))
    setHistory(items => [summary(next), ...items.filter(item => item.id !== next.id)])
    if (!isActive(next.status)) setRunningId(null)
  })

  const packages = inventory?.packages || []
  const shown = useMemo(() => packages.filter(p => (eco === 'all' || p.ecosystem === eco) && (!directOnly || p.direct)
    && (!query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()))), [packages, eco, directOnly, query])
  const toggle = key => setSelected(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const pickShown = on => setSelected(current => { const next = new Set(current); shown.forEach(p => (on ? next.add(p.key) : next.delete(p.key))); return next })

  const ecosystems = Object.keys(ECO).filter(e => packages.some(p => p.ecosystem === e))
  const scanCount = opts.mode === 'briefing' ? 0 : Math.min(selected.size, 150)
  const searches = scanCount * (opts.supply_chain ? 2 : 1) + (opts.mode !== 'packages' ? (Math.max(1, ecosystems.length) * 3 + 3 + (opts.focus.trim() ? 1 : 0)) : 0)
  const extracts = opts.opencve && scanCount ? Math.ceil(scanCount / 20) : 0
  const crawls = opts.deep_crawl && scanCount ? Math.min(6, scanCount) : 0
  const credits = searches * (opts.depth === 'advanced' ? 2 : 1) + extracts * 4 + crawls * 2
  const modelCalls = (scanCount ? Math.ceil(scanCount / 4) : 0) + (opts.mode !== 'packages' ? 1 : 0)
  const busy = Boolean(runningId) || launching
  const needsFolder = opts.mode !== 'briefing'
  const canRun = creds?.has_tavily_api_key && settings?.configured && (!needsFolder || (workspace && scanCount > 0))

  async function start() {
    runStop.begin()
    setLaunching(true)
    try {
      const started = await api.quscanRun({ workspace_id: workspace?.id || null, packages: opts.mode === 'briefing' ? [] : [...selected].slice(0, 150), options: { ...opts, focus: opts.focus.trim() } })
      setJob(started)
      setHistory(items => [summary(started), ...items.filter(item => item.id !== started.id)])
      setRunningId(started.id)
      await runStop.started(started.id)
    } catch (err) { onError(err.message) } finally { setLaunching(false) }
  }
  async function show(id) { try { setJob(await api.quscanJob(id)) } catch (err) { onError(err.message) } }
  // New scan: clear the shown result, restore the default options and package selection, and re-read the folder.
  function newScan() {
    if (busy) return
    setJob(null)
    setOpts(DEFAULT_OPTS)
    setQuery(''); setEco('all'); setDirectOnly(false)
    loadInventory()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  async function remove(id) {
    try { await api.quscanDelete(id); setHistory(items => items.filter(item => item.id !== id)); if (job?.id === id) setJob(null) } catch (err) { onError(err.message) }
  }

  const lastBriefing = history.find(h => h.status === 'completed' && (h.counts?.news || /briefing/i.test(h.title || '')))
  const stale = !lastBriefing || Date.now() - new Date(lastBriefing.created_at).getTime() > 24 * 3600 * 1000

  return <div className="grid lg:grid-cols-[330px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)] min-h-[calc(100vh-96px)]">
    <aside className="bg-panel border-r border-line flex flex-col min-w-0">
      <WorkspacePicker workspace={workspace} onWorkspace={onWorkspace} onError={onError} label="01 / Codebase" />
      {workspace ? <div className="px-5 py-4 border-b border-line">
        <div className="flex items-center justify-between gap-2">
          <p className="eyebrow">02 / Packages found</p>
          <button type="button" className="btn-icon" title="Scan the folder again" aria-label="Scan the folder again" onClick={loadInventory} disabled={invBusy || busy}>
            {invBusy ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button>
        </div>
        {inventory && <>
          <div className="grid grid-cols-3 gap-2 mt-3">
            {[['Packages', inventory.counts.total], ['Direct', inventory.counts.direct], ['Files', inventory.counts.manifests]].map(([k, v]) => <div key={k} className="qs-mini"><b>{fmt(v)}</b><span>{k}</span></div>)}
          </div>
          {inventory.manifests.length > 0 && <details className="mt-3 text-[11px]">
            <summary className="cursor-pointer text-muted">Dependency files read ({inventory.manifests.length})</summary>
            <ul className="mt-2 space-y-1 max-h-40 overflow-auto">{inventory.manifests.map(m => <li key={m.path + m.kind} className="flex gap-2 items-center">
              <span className={`qs-role qs-role-${m.role}`}>{m.role}</span><span className="font-mono truncate flex-1" title={m.path}>{m.path}</span><span className="text-muted">{m.count}</span></li>)}</ul>
          </details>}
          {!packages.length && <p className="text-xs text-amber mt-3">No dependency files, virtual environments or node_modules were found in this folder.</p>}
        </>}
      </div> : <div className="px-6 py-10 text-center text-muted">
        <ScanSearch size={25} className="mx-auto mb-4 opacity-60" />
        <p className="text-sm">Open a folder to scan its packages.</p>
        <p className="text-xs mt-2">requirements.txt, pyproject.toml, lock files, .venv and node_modules are read. A threat briefing needs no folder.</p>
      </div>}
      {packages.length > 0 && <div className="flex flex-col min-h-0 flex-1">
        <div className="px-5 pt-4 pb-2 space-y-2">
          <div className="relative"><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input className="input !pl-8 !py-1.5 text-xs" placeholder="Filter packages…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Filter packages" /></div>
          <div className="flex flex-wrap items-center gap-1.5">
            {['all', ...ecosystems].map(e => <button key={e} type="button" className={`sd-chip ${eco === e ? 'sd-chip-on' : ''}`} onClick={() => setEco(e)}>
              {e === 'all' ? 'All' : ECO[e]} {e === 'all' ? packages.length : packages.filter(p => p.ecosystem === e).length}</button>)}
            <label className="flex items-center gap-1.5 text-[11px] text-muted ml-auto"><input type="checkbox" checked={directOnly} onChange={e => setDirectOnly(e.target.checked)} />Direct only</label>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span><b className="text-fg">{selected.size}</b> selected{selected.size > 150 ? ' (first 150 are scanned)' : ''}</span>
            <span className="flex gap-2"><button type="button" className="sd-link" onClick={() => pickShown(true)}>Select shown</button><button type="button" className="sd-link" onClick={() => pickShown(false)}>Clear shown</button></span>
          </div>
        </div>
        <ul className="qs-pkglist">{shown.slice(0, 800).map(p => <li key={p.key}>
          <label className={selected.has(p.key) ? 'on' : ''}>
            <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p.key)} disabled={busy} />
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{p.name}</span>
              <span className="block truncate text-[10.5px] text-muted">{p.version || p.spec || 'any version'} · {p.version_from}{p.direct ? '' : ' · transitive'}</span></span>
            <span className={`qs-eco qs-eco-${p.ecosystem}`}>{ECO[p.ecosystem]}</span>
          </label></li>)}
          {shown.length > 800 && <li className="text-[11px] text-muted px-5 py-2">{shown.length - 800} more — filter to see them.</li>}
        </ul>
      </div>}
      <div className="p-5 border-t border-line mt-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="eyebrow flex gap-2 items-center"><History size={13} />Recent scans</h2>
          <button type="button" className="btn-small" onClick={newScan} disabled={busy} title="Start a fresh scan"><Plus size={13} />New scan</button>
        </div>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {history.map(item => <div key={item.id} className={`group flex items-start gap-1 rounded-lg hover:bg-elevated ${job?.id === item.id ? 'bg-elevated' : ''}`}>
            <button type="button" onClick={() => show(item.id)} className="flex-1 min-w-0 text-left p-2.5">
              <div className="flex gap-2 items-center">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.status === 'completed' ? 'bg-added' : item.status === 'failed' ? 'bg-removed' : 'bg-amber'} ${isActive(item.status) ? 'animate-pulse' : ''}`} />
                <span className="truncate text-xs font-medium">{item.title}</span>
              </div>
              <div className="flex justify-between text-[10px] text-muted mt-1 pl-3.5">
                <span>{new Date(item.created_at).toLocaleString()}</span>
                <span>{item.counts?.grade ? `${item.counts.score} ${item.counts.grade} · ${item.counts.vulnerable} vuln.` : item.counts?.news ? `${item.counts.news} alerts` : item.status}</span>
              </div>
            </button>
            {!isActive(item.status) && <button type="button" className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5 mr-1" title="Delete" aria-label="Delete scan" onClick={() => remove(item.id)}><Trash2 size={13} /></button>}
          </div>)}
          {!history.length && <p className="text-xs text-muted">Finished scans are saved here.</p>}
        </div>
      </div>
    </aside>

    <main className="p-5 lg:p-8 xl:p-10 min-w-0 max-w-[1600px] w-full mx-auto">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Dependency threat intelligence · Tavily web search</p>
          <h1 className="page-title flex items-center gap-3"><span className="qs-badge"><ShieldAlert size={20} /></span>QuScan</h1>
          <p className="text-sm text-muted mt-2 max-w-3xl">Finds every package your code uses, checks it against the latest CVEs, malicious releases and supply-chain attacks on the web and in OpenCVE, and tells you exactly which version to move to and how.</p>
        </div>
        {stale && <button type="button" className="qs-daily" onClick={() => { set('mode', workspace ? 'full' : 'briefing'); set('time_range', 'day') }}>
          <Bell size={14} />Today’s briefing is due · set up</button>}
      </div>

      {creds && !creds.has_tavily_api_key && <div className="qs-banner mb-5"><KeyRound size={16} className="shrink-0" />
        <span className="flex-1">Add your Tavily API key to search the web for advisories and threat news.</span>
        <button type="button" className="btn-small" onClick={onConfigure}>Open Credentials</button></div>}
      {!settings?.configured && <div className="qs-banner mb-5"><KeyRound size={16} className="shrink-0" />
        <span className="flex-1">Configure the model in Credentials; it reads the search results and writes the findings.</span>
        <button type="button" className="btn-small" onClick={onConfigure}>Open Credentials</button></div>}

      <section className="card p-5 mb-6">
        <div className="grid xl:grid-cols-[minmax(0,1fr)_300px] gap-6">
          <div>
            <p className="eyebrow mb-3">03 / What to run</p>
            <div className="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Scan mode">
              {MODES.map(({ id, icon: Icon, title, text }) => <button key={id} type="button" role="radio" aria-checked={opts.mode === id} disabled={busy}
                className={`qs-mode ${opts.mode === id ? 'qs-mode-on' : ''}`} onClick={() => set('mode', id)}>
                <Icon size={17} /><span className="text-sm font-semibold">{title}</span><span className="text-[11px] text-muted leading-snug">{text}</span></button>)}
            </div>
            <p className="eyebrow mt-5 mb-3">04 / Options</p>
            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div><label className="field-label" htmlFor="qs-depth">Search depth</label>
                <select id="qs-depth" className="input" value={opts.depth} disabled={busy} onChange={e => set('depth', e.target.value)}>
                  <option value="basic">Basic · 1 credit</option><option value="advanced">Advanced · 2 credits</option></select></div>
              <div><label className="field-label" htmlFor="qs-results">Results per search</label>
                <select id="qs-results" className="input" value={opts.results} disabled={busy} onChange={e => set('results', Number(e.target.value))}>
                  {[3, 5, 8, 10].map(n => <option key={n} value={n}>{n}</option>)}</select></div>
              <div><label className="field-label" htmlFor="qs-window">News window</label>
                <select id="qs-window" className="input" value={opts.time_range} disabled={busy || opts.mode === 'packages'} onChange={e => set('time_range', e.target.value)}>
                  {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label className="field-label" htmlFor="qs-focus">Briefing focus (optional)</label>
                <input id="qs-focus" className="input" maxLength={400} value={opts.focus} disabled={busy || opts.mode === 'packages'} placeholder="e.g. attacks on CI pipelines"
                  onChange={e => set('focus', e.target.value)} /></div>
            </div>
            <div className="grid sm:grid-cols-3 gap-2 mt-3">
              {[['opencve', 'OpenCVE database', 'Reads each package’s CVE list (scores, dates, affected and fixed versions) through Tavily extract.'],
                ['supply_chain', 'Supply-chain & malware check', 'A second search per package for malicious releases, hijacked maintainers and typosquats.'],
                ['deep_crawl', 'Deep crawl (slower)', 'Tavily crawl follows the CVE pages of the riskiest packages for exact fixed versions.']].map(([key, title, hint]) =>
                <label key={key} className={`qa-method ${opts[key] ? 'qa-method-on' : ''} ${opts.mode === 'briefing' ? 'opacity-50' : ''}`}>
                  <input type="checkbox" checked={opts[key]} disabled={busy || opts.mode === 'briefing'} onChange={e => set(key, e.target.checked)} className="mt-0.5" />
                  <span className="min-w-0"><span className="block text-xs font-semibold">{title}</span><span className="block text-[11px] text-muted leading-snug mt-0.5">{hint}</span></span>
                </label>)}
            </div>
          </div>
          <div className="flex flex-col">
            <p className="eyebrow mb-3">05 / Run</p>
            <button type="button" className="btn-primary w-full" disabled={runStop.stopping || (!busy && !canRun)} onClick={busy ? runStop.stop : start}>
              {runStop.stopping ? <LoaderCircle size={16} className="animate-spin" /> : busy ? <Square size={15} /> : <Play size={15} />}
              {runStop.stopping ? 'Stopping…' : busy ? 'Stop' : opts.mode === 'briefing' ? 'Get threat briefing' : `Scan ${scanCount} package${scanCount === 1 ? '' : 's'}`}
            </button>
            <dl className="mt-4 rounded-lg border border-line bg-ink/40 p-3 text-[11px] divide-y divide-line/60 flex-1">
              {[['Packages to scan', opts.mode === 'briefing' ? '—' : fmt(scanCount)], ['Tavily searches', fmt(searches)], ['Tavily extracts / crawls', `${extracts} / ${crawls}`],
                ['Tavily credits (approx.)', `~${fmt(credits)}`], ['Model calls (approx.)', `~${modelCalls}`]].map(([k, v]) =>
                <div key={k} className="flex justify-between gap-3 py-1.5"><dt className="text-muted">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
            </dl>
            {needsFolder && !workspace && <p className="text-[11px] text-amber mt-2">Open a folder, or choose Threat briefing.</p>}
            {needsFolder && workspace && !scanCount && <p className="text-[11px] text-amber mt-2">Select at least one package in the list.</p>}
          </div>
        </div>
      </section>

      <Result job={job} onNew={newScan} busy={busy} />
    </main>
  </div>
}

function Result({ job, onNew, busy }) {
  if (!job) return <div className="card min-h-[320px] flex flex-col items-center justify-center text-center px-8">
    <div className="qs-hero mb-5"><ShieldCheck size={34} /></div>
    <h2 className="text-xl font-semibold">Is anything you depend on under attack?</h2>
    <p className="text-muted max-w-lg text-sm mt-3 leading-relaxed">Run a scan to see vulnerable packages with the exact version to upgrade to, every CVE that applies to you, a list of safe versions, and a daily briefing of new threats. Results download as PDF and Excel.</p>
  </div>
  if (isActive(job.status)) return <Running job={job} />
  if (!job.report) return <div role="alert" className={`card p-8 ${job.status === 'cancelled' ? 'border-amber/30' : 'border-removed/30'}`}>
    <AlertTriangle className={`${job.status === 'cancelled' ? 'text-amber' : 'text-removed'} mb-4`} />
    <h2 className="text-xl font-semibold">{job.status === 'cancelled' ? 'Scan stopped' : 'The scan could not be completed'}</h2>
    <p className="text-sm text-muted mt-3">{job.error || 'No report was produced.'}</p>
    <button type="button" className="btn mt-5" onClick={onNew} disabled={busy}><Plus size={15} />New scan</button>
  </div>
  return <Report key={job.id} job={job} onNew={onNew} busy={busy} />
}

function Running({ job }) {
  const c = job.counts || {}
  const t = job.tavily || {}
  return <div role="status" className="card p-8">
    <div className="flex flex-wrap items-center gap-5">
      <div className="qs-radar"><span /><ScanSearch size={26} /></div>
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold">{job.stage || 'Preparing'}</h2>
        <p className="text-muted text-sm mt-1">{job.title}. Results appear here and are saved automatically.</p>
      </div>
    </div>
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6">
      {[['Selected', c.selected], ['Analysed', c.scanned], ['Searches', t.search], ['Extracts / crawls', `${t.extract || 0} / ${t.crawl || 0}`], ['Model tokens', `${fmt(job.usage?.input_tokens)} / ${fmt(job.usage?.output_tokens)}`]].map(([k, v]) =>
        <div key={k} className="qs-mini"><b>{typeof v === 'number' ? fmt(v) : v ?? 0}</b><span>{k}</span></div>)}
    </div>
    <ol className="qs-log mt-5">{[...(job.events || [])].reverse().slice(0, 10).map((e, i) => <li key={i} className={i === 0 ? 'now' : ''}>
      <span>{new Date(e.at).toLocaleTimeString()}</span>{e.text}</li>)}</ol>
  </div>
}

function Tile({ label, value, tone }) {
  return <div className={`qs-tile ${tone ? `qs-tile-${tone}` : ''}`}><div className="text-[11px] text-muted">{label}</div><div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div></div>
}

function Report({ job, onNew, busy }) {
  const r = job.report
  const c = job.counts || {}
  const briefing = r.briefing
  const tabs = [
    ['alerts', 'Action needed', r.alerts.length, ShieldAlert], ['briefing', 'Threat briefing', briefing?.alerts?.length || 0, Newspaper],
    ['packages', 'All packages', r.packages.length, Package], ['cves', 'CVEs', r.cves.length, AlertTriangle],
    ['safe', 'Safe versions', r.safe.length, ShieldCheck], ['files', 'Files', r.manifests.length, Layers],
  ].filter(([id, , n]) => n || id === 'alerts' || (id === 'briefing' && briefing))
  const [tab, setTab] = useState(r.alerts.length || !briefing ? 'alerts' : 'briefing')
  const cost = job.cost || {}
  const scanned = r.packages.filter(p => p.status !== 'not_scanned').length
  return <div className="space-y-5">
    {job.status !== 'completed' && <div role="status" className="qs-banner"><AlertTriangle size={16} className="shrink-0" /><span>{job.error || 'This is a partial result.'}</span></div>}
    <section className="card p-6">
      <div className="flex flex-wrap items-start gap-6">
        {r.score != null ? <ScoreRing score={r.score} grade={r.grade} /> : <div className="qs-hero"><Newspaper size={34} /></div>}
        <div className="flex-1 min-w-[260px]">
          <div className="flex flex-wrap justify-between items-start gap-3">
            <div className="min-w-0">
              <p className="eyebrow">{scanned ? 'Dependency risk' : 'Threat briefing'} · {job.status === 'completed' ? 'complete' : job.status}</p>
              <h2 className="text-2xl font-semibold mt-1">{job.workspace_name || 'Threat briefing'}</h2>
              <p className="text-muted text-xs mt-1">{new Date(job.created_at).toLocaleString()} · {job.deployment} · {job.provider_label} · Tavily {fmt(r.tavily?.search)} searches, {fmt(r.tavily?.extract)} extracts{r.tavily?.crawl ? `, ${r.tavily.crawl} crawls` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={onNew} disabled={busy} title="Start a fresh scan"><Plus size={15} />New scan</button>
              <a className="btn-primary" href={quscanDownloadUrl(job.id, 'pdf')} download><FileText size={15} />PDF</a>
              <a className="btn" href={quscanDownloadUrl(job.id, 'xlsx')} download><FileSpreadsheet size={15} />Excel</a>
              <a className="btn" href={quscanDownloadUrl(job.id, 'json')} download aria-label="Download JSON"><FileJson size={15} />JSON</a>
            </div>
          </div>
          {briefing?.headline && <p className="qs-headline mt-4"><Bell size={15} className="shrink-0 mt-0.5" /><span>{briefing.headline}</span></p>}
          {scanned > 0 && <div className="mt-4"><StackedBar segments={SEV.filter(s => s !== 'none').map(s => ({ label: s, value: r.severity_counts[s] || 0, color: SEV_COLOR[s] }))} /></div>}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mt-6">
        <Tile label="Packages scanned" value={`${fmt(scanned)} / ${fmt(r.packages.length)}`} />
        <Tile label="Vulnerable" value={fmt(c.vulnerable)} tone={c.vulnerable ? 'bad' : ''} />
        <Tile label="At risk (unpinned)" value={fmt(c.at_risk)} tone={c.at_risk ? 'warn' : ''} />
        <Tile label="CVEs affecting you" value={fmt(c.cves)} tone={c.cves ? 'bad' : ''} />
        <Tile label="News alerts · yours" value={`${fmt(c.news)} · ${fmt(c.affecting)}`} tone={c.affecting ? 'warn' : ''} />
        <Tile label={cost.complete ? 'Model cost' : 'Model tokens in / out'} value={cost.complete ? usd(cost.total_usd) : `${fmt(job.usage?.input_tokens)} / ${fmt(job.usage?.output_tokens)}`} />
      </div>
    </section>

    <div className="qs-tabs" role="tablist">{tabs.map(([id, label, n, Icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id}
      className={tab === id ? 'on' : ''} onClick={() => setTab(id)}><Icon size={14} />{label}<span>{n}</span></button>)}</div>

    {tab === 'alerts' && <Alerts rows={r.alerts} />}
    {tab === 'briefing' && briefing && <Briefing briefing={briefing} />}
    {tab === 'packages' && <Packages rows={r.packages} />}
    {tab === 'cves' && <Cves rows={r.cves} />}
    {tab === 'safe' && <Safe rows={r.safe} />}
    {tab === 'files' && <section className="card p-5"><table className="sd-table"><thead><tr><th>File</th><th>Kind</th><th>Ecosystem</th><th>Role</th><th>Packages</th></tr></thead>
      <tbody>{r.manifests.map(m => <tr key={m.path + m.kind}><td className="font-mono text-[11px] break-all">{m.path}</td><td>{m.kind}</td><td>{ECO[m.ecosystem]}</td><td><span className={`qs-role qs-role-${m.role}`}>{m.role}</span></td><td>{m.count}</td></tr>)}</tbody></table>
      {r.notes?.length > 0 && <ul className="list-disc pl-5 mt-4 text-xs text-muted">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}</section>}
    <p className="text-[11px] text-muted">Findings come from Tavily web search, the OpenCVE database and the model’s reading of those sources; CVE ids not present in the sources are discarded. Whether your version is affected is computed from the affected ranges. Review upgrades before deploying.</p>
  </div>
}

function Alerts({ rows }) {
  const [open, setOpen] = useState(() => new Set(rows.slice(0, 2).map(r => r.key)))
  if (!rows.length) return <div className="card p-8 text-center"><ShieldCheck size={28} className="mx-auto text-added mb-3" />
    <h3 className="font-semibold">No scanned package needs action</h3><p className="text-sm text-muted mt-2">No known vulnerability or compromised release in the sources affects the versions you use.</p></div>
  const toggle = key => setOpen(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  return <div className="space-y-2.5">{rows.map(r => <article key={r.key} className={`qs-alert ${open.has(r.key) ? 'open' : ''}`} style={{ '--sev': SEV_COLOR[r.severity] || SEV_COLOR.none }}>
    <button type="button" className="qs-alert-head" onClick={() => toggle(r.key)} aria-expanded={open.has(r.key)}>
      {open.has(r.key) ? <ChevronDown size={15} className="text-muted shrink-0" /> : <ChevronRight size={15} className="text-muted shrink-0" />}
      <SevPill severity={r.severity} />
      <span className="min-w-0 flex-1 text-left"><span className="block text-sm font-semibold truncate">{r.name} <span className="font-mono text-xs text-muted">{r.version || r.spec || ''}</span></span>
        <span className="block text-[11px] text-muted truncate">{ECO[r.ecosystem]} · {r.cves.filter(c => c.applies).length} CVE{r.cves.filter(c => c.applies).length === 1 ? '' : 's'} affecting you{r.threat_types?.length ? ` · ${r.threat_types.slice(0, 3).join(', ')}` : ''}</span></span>
      <StatusPill status={r.status} />
      {r.recommended_version && <span className="qs-upgrade hidden md:inline-flex">{r.version || 'any'} <span>→</span> {r.recommended_version}</span>}
      <span className="qs-danger" title="Danger score 0-10"><span style={{ width: `${r.danger_score * 10}%` }} /></span>
    </button>
    {open.has(r.key) && <div className="qs-alert-body">
      <p className="text-xs text-muted">{r.reason}</p>
      {r.summary && <p className="text-sm leading-6"><Cited text={r.summary} sources={r.evidence} /></p>}
      <div className="grid xl:grid-cols-2 gap-4">
        <div>
          {r.recommended_version ? <>
            <p className="eyebrow mb-2">Upgrade to {r.recommended_version}</p>
            <div className="space-y-1.5">{r.commands.map(cmd => <div key={cmd.label + cmd.command} className="qs-cmd"><span>{cmd.label}</span><code>{cmd.command}</code><Copy text={cmd.command} label="" /></div>)}</div>
          </> : <p className="text-xs text-amber">The sources give no fixed version yet. Follow the mitigation steps and watch for a release.</p>}
          {r.mitigation.length > 0 && <><p className="eyebrow mt-4 mb-2">Mitigation</p><ol className="list-decimal pl-5 text-sm space-y-1">{r.mitigation.map((m, i) => <li key={i}><Cited text={m} sources={r.evidence} /></li>)}</ol></>}
          {(r.affected_ranges.length > 0 || r.fixed_versions.length > 0) && <p className="text-[11px] text-muted mt-3">Affected: <span className="font-mono">{r.affected_ranges.join('; ') || '—'}</span> · Fixed in: <span className="font-mono">{r.fixed_versions.join(', ') || '—'}</span>{r.first_seen && r.first_seen !== 'unknown' ? ` · first seen ${r.first_seen}` : ''}</p>}
        </div>
        <div>
          {r.cves.length > 0 && <><p className="eyebrow mb-2">CVEs ({r.cves.length})</p>
            <div className="flex flex-wrap gap-1.5">{r.cves.slice(0, 30).map(cve => <a key={cve.id} href={cve.url} target="_blank" rel="noreferrer" className={`qs-cve ${cve.applies ? '' : 'qs-cve-off'}`}
              title={`${cve.summary || ''}${cve.applies ? '' : ' (does not affect your version)'}`} style={{ '--sev': SEV_COLOR[cve.severity] || SEV_COLOR.none }}>{cve.id}{cve.cvss ? <b>{cve.cvss}</b> : null}</a>)}</div></>}
          {r.evidence.length > 0 && <><p className="eyebrow mt-4 mb-2">Sources</p><Sources sources={r.evidence} /></>}
        </div>
      </div>
      {r.errors?.length > 0 && <p className="text-[11px] text-amber">{r.errors.join(' ')}</p>}
    </div>}
  </article>)}</div>
}

function Briefing({ briefing }) {
  const [onlyMine, setOnlyMine] = useState(false)
  const alerts = (briefing.alerts || []).filter(a => !onlyMine || a.affects.length)
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted">News from the {({ day: 'last 24 hours', week: 'last 7 days', month: 'last 30 days', year: 'last year' })[briefing.time_range] || briefing.time_range}, summarised from {briefing.sources?.length || 0} sources.</p>
      <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} />Only alerts naming my packages</label>
    </div>
    {!alerts.length && <div className="card p-6 text-sm text-muted text-center">{onlyMine ? 'No alert names a package from this folder.' : briefing.headline}</div>}
    <div className="grid xl:grid-cols-2 gap-3">{alerts.map((a, i) => <article key={i} className={`qs-news ${a.affects.length ? 'mine' : ''}`} style={{ '--sev': SEV_COLOR[a.severity] }}>
      <div className="flex flex-wrap items-center gap-2 mb-2"><SevPill severity={a.severity} /><span className="pill">{a.category}</span>
        {a.date && a.date !== 'unknown' && <span className="text-[11px] text-muted">{a.date}</span>}
        {a.affects.length > 0 && <span className="qs-mine"><ShieldAlert size={12} />Affects {a.affects_names.join(', ')}</span>}</div>
      <h3 className="text-sm font-semibold leading-5">{a.title}</h3>
      <p className="text-[13px] leading-6 mt-2 text-fg/90"><Cited text={a.summary} sources={briefing.sources} /></p>
      {a.action && <p className="qs-action mt-3"><b>Do now:</b> {a.action}</p>}
      {(a.packages.length > 0 || a.cves.length > 0) && <div className="flex flex-wrap gap-1.5 mt-3">
        {a.packages.map(p => <span key={p} className="qs-chip font-mono">{p}</span>)}
        {a.cves.map(id => <a key={id} className="qs-cve" style={{ '--sev': SEV_COLOR[a.severity] }} href={`https://app.opencve.io/cve/${id}`} target="_blank" rel="noreferrer">{id}</a>)}</div>}
      <div className="flex flex-wrap gap-1 mt-3">{a.sources.map(n => briefing.sources[n - 1] && <a key={n} href={briefing.sources[n - 1].url} target="_blank" rel="noreferrer" className="qs-srcchip" title={briefing.sources[n - 1].title}>
        <Favicon src={briefing.sources[n - 1]} />{briefing.sources[n - 1].domain}</a>)}</div>
    </article>)}</div>
    {briefing.sources?.length > 0 && <details className="card p-5"><summary className="cursor-pointer text-sm font-semibold">All news sources ({briefing.sources.length})</summary><div className="mt-3"><Sources sources={briefing.sources} /></div></details>}
  </div>
}

function Packages({ rows }) {
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const shown = rows.filter(r => (status === 'all' || r.status === status) && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())))
  return <section className="card p-5">
    <div className="flex flex-wrap items-center gap-1.5 mb-4">
      {['all', ...Object.keys(STATUS)].map(s => { const n = s === 'all' ? rows.length : rows.filter(r => r.status === s).length; return n ? <button key={s} type="button" className={`sd-chip ${status === s ? 'sd-chip-on' : ''}`} onClick={() => setStatus(s)}>{s === 'all' ? 'All' : STATUS[s].label} {n}</button> : null })}
      <div className="relative ml-auto"><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input className="input !pl-8 !py-1.5 text-xs w-52" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search packages" /></div>
    </div>
    <div className="overflow-x-auto"><table className="sd-table"><thead><tr><th>Package</th><th>Ecosystem</th><th>Version</th><th>Status</th><th>Severity</th><th>CVEs</th><th>Safe version</th><th>Found in</th></tr></thead>
      <tbody>{shown.slice(0, 1000).map(r => <tr key={r.key}><td className="font-medium">{r.name}{!r.direct && <span className="text-[10px] text-muted"> · transitive</span>}</td><td>{ECO[r.ecosystem]}</td>
        <td className="font-mono text-[11px]">{r.version || r.spec || '—'}<span className="block text-[10px] text-muted font-sans">{r.version_from}</span></td>
        <td><StatusPill status={r.status} /></td><td><SevPill severity={r.severity} /></td><td>{r.cves.filter(c => c.applies).length || ''}{r.cves.length && !r.cves.some(c => c.applies) ? <span className="text-[10px] text-muted">{r.cves.length} old</span> : ''}</td>
        <td className="font-mono text-[11px]">{r.safe_version || '—'}</td><td className="text-[10.5px] text-muted font-mono break-all">{r.sources.slice(0, 3).join(', ')}</td></tr>)}</tbody></table></div>
  </section>
}

function Cves({ rows }) {
  const [mine, setMine] = useState(true)
  const shown = rows.filter(c => !mine || c.applies)
  return <section className="card p-5">
    <label className="flex items-center gap-2 text-xs text-muted mb-4"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />Only CVEs that affect the versions you use ({rows.filter(c => c.applies).length} of {rows.length})</label>
    <div className="overflow-x-auto"><table className="sd-table"><thead><tr><th>CVE</th><th>Package</th><th>Your version</th><th>CVSS</th><th>Affected</th><th>Fixed in</th><th>Updated</th><th>Summary</th></tr></thead>
      <tbody>{shown.slice(0, 1000).map(c => <tr key={c.package_key + c.id}><td><a className="qs-cve" style={{ '--sev': SEV_COLOR[c.severity] || SEV_COLOR.none }} href={c.url} target="_blank" rel="noreferrer">{c.id}</a></td>
        <td className="font-medium">{c.package}</td><td className="font-mono text-[11px]">{c.project_version || '—'}</td><td className="tabular-nums">{c.cvss ?? '—'}</td>
        <td className="font-mono text-[11px]">{c.affected || '—'}</td><td className="font-mono text-[11px]">{c.fixed_in || '—'}</td><td className="text-[11px] whitespace-nowrap">{c.updated || ''}</td>
        <td className="text-[12px] text-muted min-w-[280px]">{c.summary}</td></tr>)}</tbody></table></div>
    {!shown.length && <p className="text-sm text-muted text-center py-4">No CVE affects the versions you use.</p>}
  </section>
}

function Safe({ rows }) {
  const groups = Object.keys(ECO).map(e => [e, rows.filter(r => r.ecosystem === e)]).filter(([, list]) => list.length)
  const pinFile = (e, list) => (e === 'pypi' ? list.filter(r => r.safe_version).map(r => `${r.name}==${r.safe_version}`).join('\n')
    : JSON.stringify(Object.fromEntries(list.filter(r => r.safe_version).map(r => [r.name, r.safe_version])), null, 2))
  return <div className="space-y-4">{groups.map(([e, list]) => <section key={e} className="card p-5">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h3 className="section-title !text-base"><ShieldCheck size={16} className="text-added" />{ECO[e]} · versions to use <span className="pill">{list.length}</span></h3>
      <Copy text={pinFile(e, list)} label={e === 'pypi' ? 'Copy as requirements.txt' : 'Copy as package.json dependencies'} />
    </div>
    <div className="overflow-x-auto"><table className="sd-table"><thead><tr><th>Package</th><th>Current</th><th>Use version</th><th>Status</th><th>Why</th></tr></thead>
      <tbody>{list.map(s => <tr key={s.key}><td className="font-medium">{s.name}</td><td className="font-mono text-[11px]">{s.current || '—'}</td>
        <td className="font-mono text-[11px] font-semibold">{s.safe_version || '—'}</td><td><StatusPill status={s.status} /></td><td className="text-[12px] text-muted">{s.basis}</td></tr>)}</tbody></table></div>
  </section>)}</div>
}
