import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown, ArrowUp, ArrowUpDown, BadgeDollarSign, Bot, ChevronLeft, ChevronRight, Code2, Coins, Download,
  FileSearch, Filter, KeyRound, Layers, MessagesSquare, RefreshCw, Search, ShieldAlert, Sigma, Tags, Users, X,
} from 'lucide-react'
import { api } from '../api.js'
import BrandLoader from './BrandLoader.jsx'
import './Dashboard.css'

// Cost & token dashboard (backend: dashboard.py). Every run of the four solutions with its tokens, cost,
// provider, model and keys; filters, grouping, sorting, charts and CSV export all work in the browser.
const SOLUTIONS = [
  { id: 'QuReview', icon: FileSearch, color: '#0ea5e9' },
  { id: 'QuCoder', icon: Code2, color: '#0d9488' },
  { id: 'QuBot', icon: MessagesSquare, color: '#8b5cf6' },
  { id: 'QuScan', icon: ShieldAlert, color: '#ef4444' },
]
const COLOR = Object.fromEntries(SOLUTIONS.map(s => [s.id, s.color]))
const RANGES = [['7d', '7 days', 7], ['30d', '30 days', 30], ['90d', '90 days', 90], ['365d', '12 months', 365], ['all', 'All time', 0]]
const GROUPS = [['solution', 'Solution', Layers], ['mode', 'Mode', Tags], ['provider_label', 'Provider', Bot],
  ['model', 'Model', Sigma], ['keys_label', 'Keys', KeyRound], ['workspace', 'Codebase', FileSearch], ['owner', 'Person', Users]]
const METRICS = [['cost', 'Cost'], ['tokens', 'Tokens'], ['runs', 'Runs']]
const COLUMNS = [
  ['created_at', 'When'], ['solution', 'Solution'], ['mode', 'Mode'], ['title', 'Run'], ['provider_label', 'Provider'],
  ['model', 'Model'], ['keys_label', 'Keys'], ['input_tokens', 'Input', true], ['output_tokens', 'Output', true],
  ['embedding_tokens', 'Embedding', true], ['cost_usd', 'Cost', true], ['status', 'Status'],
]
const PAGE = 25

const money = v => {
  const n = Number(v) || 0
  if (n === 0) return '$0.00'
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}
const compact = v => {
  const n = Number(v) || 0
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString()
}
const tokens = r => r.input_tokens + r.output_tokens + r.embedding_tokens
const valueOf = (r, metric) => (metric === 'cost' ? r.cost_usd : metric === 'tokens' ? tokens(r) : 1)
const fmt = (v, metric) => (metric === 'cost' ? money(v) : compact(v))
const day = iso => (iso || '').slice(0, 10)
const when = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
const rate = v => (v === null || v === undefined || v === '' ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 })}`)

export default function Dashboard({ onError }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scope] = useState('mine')  // one local user: always this computer's runs
  const [range, setRange] = useState('30d')
  const [solutions, setSolutions] = useState(() => new Set())
  const [filters, setFilters] = useState({ provider_label: '', model: '', keys_label: '', status: '' })
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('model')
  const [metric, setMetric] = useState('cost')
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' })
  const [page, setPage] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  async function load(nextScope = scope) {
    setLoading(true)
    try { setData(await api.dashboard(nextScope)) } catch (err) { onError?.(err.message) } finally { setLoading(false) }
  }
  useEffect(() => { load(scope) }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(0) }, [range, solutions, filters, query, sort, scope])

  const runs = data?.runs || []
  const cutoff = useMemo(() => {
    const days = RANGES.find(r => r[0] === range)?.[2] || 0
    return days ? new Date(Date.now() - days * 86400000).toISOString() : ''
  }, [range])
  const options = useMemo(() => {
    const pick = key => [...new Set(runs.map(r => r[key]).filter(Boolean))].sort()
    return { provider_label: pick('provider_label'), model: pick('model'), keys_label: pick('keys_label'), status: pick('status') }
  }, [runs])
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return runs.filter(r => (!cutoff || r.created_at >= cutoff)
      && (!solutions.size || solutions.has(r.solution))
      && Object.entries(filters).every(([k, v]) => !v || r[k] === v)
      && (!q || [r.title, r.workspace, r.model, r.mode, r.provider_label, r.owner].some(v => String(v || '').toLowerCase().includes(q))))
  }, [runs, cutoff, solutions, filters, query])
  const totals = useMemo(() => {
    const t = { cost: 0, input: 0, output: 0, embedding: 0, runs: rows.length, partial: 0, byok: 0, tavily: 0, requests: 0 }
    for (const r of rows) {
      t.cost += r.cost_usd; t.input += r.input_tokens; t.output += r.output_tokens; t.embedding += r.embedding_tokens
      t.requests += r.requests; t.tavily += r.tavily_calls
      if (!r.cost_complete) t.partial += 1
      if (r.keys === 'byok') t.byok += r.cost_usd
    }
    return t
  }, [rows])
  const bySolution = useMemo(() => SOLUTIONS.map(s => {
    const mine = rows.filter(r => r.solution === s.id)
    return { ...s, runs: mine.length, cost: mine.reduce((a, r) => a + r.cost_usd, 0), tokens: mine.reduce((a, r) => a + tokens(r), 0) }
  }), [rows])
  const breakdown = useMemo(() => {
    const map = new Map()
    for (const r of rows) {
      const key = r[group] || (group === 'owner' ? 'You' : 'Unknown')
      const item = map.get(key) || { key, value: 0, cost: 0, tokens: 0, runs: 0 }
      item.value += valueOf(r, metric); item.cost += r.cost_usd; item.tokens += tokens(r); item.runs += 1
      map.set(key, item)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }, [rows, group, metric])
  const timeline = useMemo(() => {
    const days = RANGES.find(r => r[0] === range)?.[2] || 0
    const monthly = !days || days > 92
    const bucket = iso => (monthly ? (iso || '').slice(0, 7) : day(iso))
    const map = new Map()
    if (!monthly) {
      for (let i = days - 1; i >= 0; i -= 1) map.set(day(new Date(Date.now() - i * 86400000).toISOString()), {})
    }
    for (const r of rows) {
      const b = bucket(r.created_at)
      if (!b) continue
      const item = map.get(b) || {}
      item[r.solution] = (item[r.solution] || 0) + valueOf(r, metric)
      map.set(b, item)
    }
    return { monthly, items: [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])) }
  }, [rows, range, metric])
  const sorted = useMemo(() => {
    const { key, dir } = sort
    const sign = dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = a[key], y = b[key]
      if (typeof x === 'number' || typeof y === 'number') return ((Number(x) || 0) - (Number(y) || 0)) * sign
      return String(x || '').localeCompare(String(y || '')) * sign
    })
  }, [rows, sort])
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE))
  const shown = sorted.slice(page * PAGE, page * PAGE + PAGE)
  const active = solutions.size + Object.values(filters).filter(Boolean).length + (query ? 1 : 0)

  function toggleSolution(id) {
    setSolutions(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function sortBy(key) {
    setSort(current => (current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'created_at' || COLUMNS.find(c => c[0] === key)?.[2] ? 'desc' : 'asc' }))
  }
  function clear() { setSolutions(new Set()); setFilters({ provider_label: '', model: '', keys_label: '', status: '' }); setQuery('') }
  function exportCsv() {
    const head = ['created_at', 'solution', 'mode', 'title', 'workspace', 'provider', 'model', 'embedding_model', 'keys',
      'price_source', 'input_per_million', 'output_per_million', 'input_tokens', 'output_tokens', 'embedding_tokens', 'requests',
      'cost_usd', 'cost_complete', 'status', ...(data?.scope === 'all' ? ['owner'] : [])]
    const cell = v => `"${String(v ?? '').replaceAll('"', '""')}"`
    const lines = [head.join(','), ...sorted.map(r => head.map(h => cell(h === 'provider' ? r.provider_label : h === 'keys' ? r.keys_label : r[h])).join(','))]
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = `qucore-usage-${day(new Date().toISOString())}.csv`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function refreshPrices() {
    setRefreshing(true)
    try { const pricing = await api.pricingRefresh(); setData(d => ({ ...d, pricing })) } catch (err) { onError?.(err.message) } finally { setRefreshing(false) }
  }

  if (loading && !data) return <BrandLoader label="Loading your usage" className="py-24" />

  return <section className="dash @container max-w-[1600px] mx-auto p-5 lg:p-8 xl:p-10">
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div>
        <p className="eyebrow">Usage &amp; spend</p>
        <h1 className="page-title">Cost &amp; token dashboard</h1>
        <p className="text-muted text-sm mt-1">Every run across QuReview, QuCoder, QuBot and QuScan, priced with live model prices where known.</p>
        <DataNote data={data} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={() => load()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Reload</button>
        <button type="button" className="btn" onClick={exportCsv} disabled={!rows.length}><Download size={14} />Export CSV</button>
      </div>
    </div>

    {/* filters */}
    <div className="dash-card dash-filters">
      <div className="dash-seg" role="group" aria-label="Period">
        {RANGES.map(([id, label]) => <button key={id} type="button" className={range === id ? 'on' : ''} onClick={() => setRange(id)}>{label}</button>)}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SOLUTIONS.map(s => <button key={s.id} type="button" onClick={() => toggleSolution(s.id)}
          className={`dash-chip ${solutions.has(s.id) ? 'on' : ''}`} style={{ '--c': s.color }}>
          <s.icon size={13} />{s.id}</button>)}
      </div>
      <div className="dash-selects">
        {[['provider_label', 'All providers'], ['model', 'All models'], ['keys_label', 'All keys'], ['status', 'Any status']].map(([key, label]) =>
          <select key={key} className="input dash-select" value={filters[key]} aria-label={label}
            onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))}>
            <option value="">{label}</option>
            {options[key].map(v => <option key={v} value={v}>{v}</option>)}
          </select>)}
        <label className="dash-search"><Search size={14} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search runs, codebases, models" /></label>
        {active > 0 && <button type="button" className="btn-small" onClick={clear}><X size={13} />Clear {active}</button>}
      </div>
    </div>

    {/* KPIs */}
    <div className="dash-kpis">
      <Kpi icon={BadgeDollarSign} label="Total cost" value={money(totals.cost)}
        note={totals.partial ? `${totals.partial} run${totals.partial === 1 ? '' : 's'} partly priced` : 'All runs priced'} accent />
      <Kpi icon={Sigma} label="Runs" value={compact(totals.runs)} note={`${compact(totals.requests)} model calls`} />
      <Kpi icon={ArrowDown} label="Input tokens" value={compact(totals.input)} note={money(rows.reduce((a, r) => a + r.input_usd, 0))} />
      <Kpi icon={ArrowUp} label="Output tokens" value={compact(totals.output)} note={money(rows.reduce((a, r) => a + r.output_usd, 0))} />
      <Kpi icon={Layers} label="Embedding tokens" value={compact(totals.embedding)} note={money(rows.reduce((a, r) => a + r.embedding_usd, 0))} />
      <Kpi icon={Coins} label="Average per run" value={money(totals.runs ? totals.cost / totals.runs : 0)}
        note={totals.cost ? `${Math.round((totals.byok / totals.cost) * 100)}% on your own keys` : 'No spend yet'} />
    </div>

    {/* solutions */}
    <div className="dash-solutions">
      {bySolution.map(s => {
        const share = totals.cost ? (s.cost / totals.cost) * 100 : 0
        return <button key={s.id} type="button" onClick={() => toggleSolution(s.id)}
          className={`dash-card dash-solution ${solutions.has(s.id) ? 'on' : ''}`} style={{ '--c': s.color }}>
          <span className="dash-solution-icon"><s.icon size={17} /></span>
          <span className="min-w-0 flex-1 text-left">
            <b>{s.id}</b>
            <span className="block text-xs text-muted">{s.runs} run{s.runs === 1 ? '' : 's'} · {compact(s.tokens)} tokens</span>
            <span className="dash-bar"><span style={{ width: `${share}%` }} /></span>
          </span>
          <span className="text-right"><b className="tabular-nums">{money(s.cost)}</b><span className="block text-xs text-muted">{share.toFixed(0)}%</span></span>
        </button>
      })}
    </div>

    <div className="dash-grid">
      <div className="dash-card">
        <div className="dash-card-head">
          <h2>{METRICS.find(m => m[0] === metric)[1]} over time <span>{timeline.monthly ? 'by month' : 'by day'}</span></h2>
          <div className="dash-seg small" role="group" aria-label="Measure">
            {METRICS.map(([id, label]) => <button key={id} type="button" className={metric === id ? 'on' : ''} onClick={() => setMetric(id)}>{label}</button>)}
          </div>
        </div>
        <TimeChart timeline={timeline} metric={metric} />
        <div className="dash-legend">{SOLUTIONS.map(s => <span key={s.id}><i style={{ background: s.color }} />{s.id}</span>)}</div>
      </div>
      <div className="dash-card">
        <div className="dash-card-head">
          <h2>Breakdown <span>{METRICS.find(m => m[0] === metric)[1].toLowerCase()} by {GROUPS.find(g => g[0] === group)[1].toLowerCase()}</span></h2>
          <select className="input dash-select" value={group} onChange={e => setGroup(e.target.value)} aria-label="Group by">
            {GROUPS.filter(g => g[0] !== 'owner' || data?.scope === 'all').map(([id, label]) => <option key={id} value={id}>By {label.toLowerCase()}</option>)}
          </select>
        </div>
        <Breakdown items={breakdown} metric={metric} total={breakdown.reduce((a, i) => a + i.value, 0)} />
      </div>
    </div>

    <PricesPanel pricing={data?.pricing} admin={data?.admin} refreshing={refreshing} onRefresh={refreshPrices} onError={onError} />

    {/* runs table */}
    <div className="dash-card mt-5 p-0 overflow-hidden">
      <div className="dash-card-head px-5 pt-4">
        <h2>Runs <span>{rows.length.toLocaleString()} of {runs.length.toLocaleString()}</span></h2>
        {active > 0 && <span className="text-xs text-muted inline-flex items-center gap-1"><Filter size={12} />{active} filter{active === 1 ? '' : 's'}</span>}
      </div>
      <div className="dash-table-wrap">
        <table className="dash-table">
          <thead><tr>
            {COLUMNS.map(([key, label, numeric]) => <th key={key} className={numeric ? 'num' : ''} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button type="button" onClick={() => sortBy(key)}>{label}
                {sort.key === key ? (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ArrowUpDown size={11} className="opacity-40" />}
              </button></th>)}
            {data?.scope === 'all' && <th>Person</th>}
          </tr></thead>
          <tbody>
            {shown.map(r => <tr key={`${r.solution}-${r.id}`}>
              <td className="whitespace-nowrap text-muted">{when(r.created_at)}</td>
              <td><span className="dash-pill" style={{ '--c': COLOR[r.solution] }}>{r.solution}</span></td>
              <td className="whitespace-nowrap">{r.mode}</td>
              <td className="dash-title" title={`${r.title}${r.workspace ? ` · ${r.workspace}` : ''}`}>{r.title || '—'}{r.workspace && <span>{r.workspace}</span>}</td>
              <td className="whitespace-nowrap">{r.provider_label}</td>
              <td className="font-mono text-xs dash-model" title={r.price_key ? `Priced as ${r.price_key} (${r.price_source})` : r.price_source}>{r.model}</td>
              <td className="whitespace-nowrap"><span className={`dash-keys ${r.keys}`}>{r.keys_label}</span></td>
              <td className="num">{compact(r.input_tokens)}</td>
              <td className="num">{compact(r.output_tokens)}</td>
              <td className="num">{compact(r.embedding_tokens)}</td>
              <td className="num font-semibold">{money(r.cost_usd)}{!r.cost_complete && <sup title="Some usage was not priced or not reported">*</sup>}</td>
              <td><span className={`dash-status ${r.status}`}>{r.status || '—'}</span></td>
              {data?.scope === 'all' && <td className="font-mono text-xs whitespace-nowrap">{r.owner || '—'}</td>}
            </tr>)}
            {!shown.length && <tr><td colSpan={COLUMNS.length + 1} className="text-center text-muted py-12">
              {runs.length ? 'No runs match these filters.' : 'No runs yet. Costs appear here after your first review, chat or scan.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && <div className="dash-pager">
        <span className="text-xs text-muted">Page {page + 1} of {pages}</span>
        <div className="flex gap-1">
          <button type="button" className="btn-small" disabled={!page} onClick={() => setPage(p => p - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
          <button type="button" className="btn-small" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
        </div>
      </div>}
      <p className="text-[11px] text-muted px-5 pb-4">* Partly priced: a provider did not report some usage, or no price was known for a model. Costs are estimates from reported tokens × prices, not invoices.</p>
    </div>
  </section>
}

// What "My usage" and "Everyone" mean, and where the numbers come from.
function DataNote({ data }) {
  if (!data) return null
  const scope = 'Every run on this computer is shown (QuCoRe runs locally, without sign-in).'
  return <div className="dash-note">
    <p>{scope}</p>
    <p>Real runs only: tokens are what each provider reported; cost is those tokens × the price in use when the run happened
      (runs saved before live pricing used the .env prices; "Not recorded" means an older run did not store its model).
      {data.storage && <> Read from {data.storage.database} and {data.storage.files}.</>}</p>
  </div>
}

function Kpi({ icon: Icon, label, value, note, accent }) {
  return <div className={`dash-card dash-kpi ${accent ? 'accent' : ''}`}>
    <span className="dash-kpi-icon"><Icon size={16} /></span>
    <span className="text-xs text-muted">{label}</span>
    <b className="tabular-nums">{value}</b>
    <span className="text-[11px] text-muted truncate">{note}</span>
  </div>
}

function TimeChart({ timeline, metric }) {
  const [hover, setHover] = useState(null)
  const items = timeline.items
  if (!items.length) return <p className="text-sm text-muted py-16 text-center">No runs in this period.</p>
  const W = 720, H = 220, P = { l: 52, r: 8, t: 10, b: 26 }
  const totals = items.map(([, v]) => SOLUTIONS.reduce((a, s) => a + (v[s.id] || 0), 0))
  const max = Math.max(...totals, metric === 'cost' ? 0.01 : 1)
  const step = (W - P.l - P.r) / items.length
  const bar = Math.max(2, Math.min(28, step * 0.7))
  const y = v => P.t + (H - P.t - P.b) * (1 - v / max)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max * f)
  const every = Math.ceil(items.length / 8)
  return <div className="dash-chart">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spend over time by solution" preserveAspectRatio="none">
      {ticks.map(t => <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className="grid" />
        <text x={P.l - 6} y={y(t) + 3} textAnchor="end">{fmt(t, metric)}</text></g>)}
      {items.map(([label, v], i) => {
        let top = H - P.b
        const x = P.l + i * step + (step - bar) / 2
        return <g key={label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <rect x={P.l + i * step} y={P.t} width={step} height={H - P.t - P.b} fill="transparent" />
          {SOLUTIONS.map(s => {
            const value = v[s.id] || 0
            if (!value) return null
            const h = (H - P.t - P.b) * (value / max)
            top -= h
            return <rect key={s.id} x={x} y={top} width={bar} height={Math.max(h, 0.5)} rx={Math.min(3, bar / 3)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.45} />
          })}
          {i % every === 0 && <text x={x + bar / 2} y={H - 8} textAnchor="middle">{timeline.monthly ? label : label.slice(5)}</text>}
        </g>
      })}
    </svg>
    {hover !== null && <div className="dash-tip">
      <b>{items[hover][0]}</b>
      {SOLUTIONS.filter(s => items[hover][1][s.id]).map(s => <span key={s.id}><i style={{ background: s.color }} />{s.id}<em>{fmt(items[hover][1][s.id], metric)}</em></span>)}
      <span className="total">Total<em>{fmt(totals[hover], metric)}</em></span>
    </div>}
  </div>
}

function Breakdown({ items, metric, total }) {
  const [all, setAll] = useState(false)
  if (!items.length) return <p className="text-sm text-muted py-16 text-center">Nothing to break down yet.</p>
  const list = all ? items : items.slice(0, 8)
  const max = Math.max(...items.map(i => i.value), 1e-9)
  return <div className="dash-breakdown">
    {list.map(item => <div key={item.key} className="dash-brow" title={`${item.key}: ${money(item.cost)} · ${compact(item.tokens)} tokens · ${item.runs} runs`}>
      <span className="name">{item.key}</span>
      <span className="track"><span style={{ width: `${(item.value / max) * 100}%`, background: COLOR[item.key] || undefined }} /></span>
      <span className="val tabular-nums">{fmt(item.value, metric)}<em>{total ? `${Math.round((item.value / total) * 100)}%` : ''}</em></span>
    </div>)}
    {items.length > 8 && <button type="button" className="btn-small mt-2" onClick={() => setAll(a => !a)}>{all ? 'Show top 8' : `Show all ${items.length}`}</button>}
  </div>
}

function PricesPanel({ pricing, admin, refreshing, onRefresh, onError }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [models, setModels] = useState(null)
  useEffect(() => {
    if (!open) return undefined
    const timer = setTimeout(() => { api.pricingCatalogue(q).then(r => setModels(r.models)).catch(err => onError?.(err.message)) }, 250)
    return () => clearTimeout(timer)
  }, [open, q]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!pricing) return null
  const c = pricing.current || {}
  return <div className="dash-card mt-5">
    <div className="dash-card-head">
      <h2>Prices in use <span>{pricing.enabled ? 'live model prices, stored and reused' : 'backend/.env prices (live prices off)'}</span></h2>
      <div className="flex gap-2">
        <button type="button" className="btn-small" onClick={() => setOpen(o => !o)}><Search size={13} />{open ? 'Hide catalogue' : 'Price catalogue'}</button>
        {admin && <button type="button" className="btn-small" onClick={onRefresh} disabled={refreshing || pricing.fetching}>
          <RefreshCw size={13} className={refreshing || pricing.fetching ? 'animate-spin' : ''} />Refresh prices</button>}
      </div>
    </div>
    <div className="dash-prices">
      <div className="dash-price-now">
        <span className="text-xs text-muted">Current model</span>
        <b className="font-mono text-sm break-all">{c.model || '—'}</b>
        <span className="text-xs text-muted">{c.provider_label || '—'} · {c.keys === 'byok' ? 'your Nebius key' : 'server keys'}</span>
        <div className="dash-rates">
          <span><em>Input</em>{rate(c.input_per_million)}<i>/M</i></span>
          <span><em>Output</em>{rate(c.output_per_million)}<i>/M</i></span>
          <span><em>Embedding</em>{rate(c.embedding_per_million)}<i>/M</i></span>
        </div>
        <span className="text-[11px] text-muted">Source: {c.source_label || '—'}{c.price_key ? ` (${c.price_key})` : ''}</span>
      </div>
      <div className="dash-sources">
        {(pricing.sources || []).map(s => <div key={s.id} className="dash-source">
          <b>{s.label}</b>
          <span className="text-xs text-muted">{s.models.toLocaleString()} models{s.fetched_at ? ` · updated ${when(new Date(s.fetched_at * 1000).toISOString())}` : ' · not fetched yet'}</span>
          {s.error && <span className="text-[11px] text-amber">Last attempt failed: {s.error}</span>}
        </div>)}
        <p className="text-[11px] text-muted">Fetched at most every {Math.round(pricing.refresh_hours || 168)} hours and when a new model is chosen; unknown models use the .env prices. Prices: the <a href="https://github.com/BerriAI/litellm" target="_blank" rel="noreferrer" className="underline">LiteLLM</a> public price catalogue (JSON only, no package installed).</p>
      </div>
    </div>
    {open && <div className="mt-4">
      <label className="dash-search max-w-md"><Search size={14} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a model, e.g. nemotron, qwen" autoFocus /></label>
      <div className="dash-table-wrap mt-3 max-h-80">
        <table className="dash-table">
          <thead><tr><th>Model</th><th>Provider</th><th>Type</th><th className="num">Input /M</th><th className="num">Output /M</th><th className="num">Cached /M</th><th>Source</th></tr></thead>
          <tbody>
            {!models && <tr><td colSpan={7}><BrandLoader size="sm" label="Loading prices" /></td></tr>}
            {models?.map(m => <tr key={`${m.source}-${m.key}`}>
              <td className="font-mono text-xs">{m.key}</td><td>{m.provider}</td><td>{m.mode}</td>
              <td className="num">{rate(m.input)}</td><td className="num">{rate(m.output)}</td><td className="num">{rate(m.cached_input)}</td>
              <td className="text-xs text-muted">LiteLLM</td></tr>)}
            {models && !models.length && <tr><td colSpan={7} className="text-center text-muted py-6">No stored prices match. Refresh the catalogue to fetch it again.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>}
  </div>
}
