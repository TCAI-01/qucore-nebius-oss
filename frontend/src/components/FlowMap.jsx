import { Component, Fragment, lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileCode2, FileJson, History, Info, KeyRound, LoaderCircle, Square, Trash2, Workflow, X } from 'lucide-react'
import { api } from '../api.js'
import TabTitle from './TabTitle.jsx'
import useRunStop from '../useRunStop.js'
import FileTree, { Checkbox, collectFiles } from './FileTree.jsx'
import FlowDiagram from './FlowDiagram.jsx'
import UmlView from './UmlView.jsx'
import WorkspacePicker from './WorkspacePicker.jsx'
import { money } from './UsageMetrics.jsx'
import { KINDS } from '../flowMermaid.js'
import BrandLoader from './BrandLoader.jsx'

const number = value => Number(value || 0).toLocaleString()
const ReactFlowDiagram = lazy(() => import('./ReactFlowDiagram.jsx'))

class RendererBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <>
      <p role="alert" className="px-4 py-3 text-xs text-amber border-b border-line">React Flow could not load. Showing Mermaid; your saved graph is unchanged.</p>
      {this.props.fallback}
    </>
    return this.props.children
  }
}

// `code` spans inside model sentences, without a Markdown renderer.
export function InlineCode({ text }) {
  return String(text || '').split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2
      ? <code key={i} className="flow-code">{part.slice(1, -1)}</code>
      : <Fragment key={i}>{part}</Fragment>)
}

function usePolling(id, load, onUpdate) {
  useEffect(() => {
    if (!id) return
    let stopped = false
    let timer
    async function poll() {
      try {
        const next = await load(id)
        if (stopped) return
        onUpdate(next)
        if (!['queued', 'running'].includes(next.status)) return
      } catch { /* retried below */ }
      if (!stopped) timer = setTimeout(poll, 1500)
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
}

export default function FlowMap({
  workspace,
  onWorkspace,
  settings,
  light,
  onError,
  onConfigure,
  view = 'flow',
  onViewChange,
  umlOpen,
}) {
  const [selected, setSelected] = useState(new Set())
  const [detail, setDetail] = useState('overview')
  const [focus, setFocus] = useState('')
  const [reactFlow, setReactFlow] = useState(false)
  const [plan, setPlan] = useState(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planError, setPlanError] = useState('')
  const [job, setJob] = useState(null)
  const [history, setHistory] = useState([])
  const [runningId, setRunningId] = useState(null)
  const [launching, setLaunching] = useState(false)
  const [hover, setHover] = useState(null)
  const [pinned, setPinned] = useState(null)
  const [nodeId, setNodeId] = useState(null)
  const runStop = useRunStop(runningId, launching, api.flowStop, onError)

  const files = useMemo(() => (workspace ? collectFiles(workspace.tree) : []), [workspace])
  useEffect(() => { setSelected(new Set()) }, [workspace?.id])
  useEffect(() => { api.flows().then(items => {
    setHistory(items)
    const pending = items.find(item => ['queued', 'running'].includes(item.status))
    if (pending) setRunningId(pending.id)
  }).catch(() => {}) }, [])

  // Token plan for the current selection (debounced, like the Review tab).
  useEffect(() => {
    setPlan(null)
    setPlanError('')
    if (!workspace || !selected.size) { setPlanBusy(false); return }
    const controller = new AbortController()
    setPlanBusy(true)
    const timer = setTimeout(async () => {
      try {
        const result = await api.flowPreview({ workspace_id: workspace.id, files: [...selected], detail, focus: '' }, controller.signal)
        if (!controller.signal.aborted) setPlan(result)
      } catch (err) {
        if (!controller.signal.aborted) setPlanError(err.message)
      } finally {
        if (!controller.signal.aborted) setPlanBusy(false)
      }
    }, 500)
    return () => { clearTimeout(timer); controller.abort() }
  }, [workspace, selected, detail, settings])

  usePolling(runningId, api.flow, next => {
    setJob(current => (!current || current.id === next.id ? next : current))
    setHistory(items => [summary(next), ...items.filter(item => item.id !== next.id)])
    if (!['queued', 'running'].includes(next.status)) setRunningId(null)
  })

  const selectPaths = (paths, enabled) => setSelected(current => {
    const next = new Set(current)
    paths.forEach(path => (enabled ? next.add(path) : next.delete(path)))
    return next
  })

  async function generate() {
    runStop.begin()
    setLaunching(true)
    try {
      const started = await api.flowRun({ workspace_id: workspace.id, files: [...selected], detail, focus: focus.trim() })
      resetView()
      setJob(started)
      setHistory(items => [summary(started), ...items])
      setRunningId(started.id)
      await runStop.started(started.id)
    } catch (err) {
      onError(err.message)
    } finally {
      setLaunching(false)
    }
  }
  function resetView() { setHover(null); setPinned(null); setNodeId(null) }
  async function show(id) {
    try { resetView(); setJob(await api.flow(id)) } catch (err) { onError(err.message) }
  }
  async function remove(id) {
    try {
      await api.flowDelete(id)
      setHistory(items => items.filter(item => item.id !== id))
      if (job?.id === id) setJob(null)
    } catch (err) { onError(err.message) }
  }

  const busy = Boolean(runningId) || launching
  const canRun = !busy && workspace && selected.size && plan?.can_run && !planBusy && settings?.configured

  return <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[350px_minmax(0,1fr)] min-h-[calc(100vh-96px)]">
    <aside className="bg-panel border-r border-line flex flex-col min-w-0">
      <WorkspacePicker workspace={workspace} onWorkspace={onWorkspace} onError={onError} label="01 / Codebase" />
      {workspace ? <>
        <div className="px-5 py-4 border-b border-line">
          <div className="flex justify-between gap-3 items-center">
            <span className="text-sm font-semibold truncate" title={workspace.root}>{workspace.name}</span>
            <span className="pill">{selected.size} selected</span>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted mt-3">
            <Checkbox checked={files.length > 0 && selected.size === files.length} mixed={selected.size > 0 && selected.size < files.length}
              disabled={!files.length} onChange={() => selectPaths(files, selected.size !== files.length)} />
            Select all eligible files <span className="ml-auto">{files.length}</span>
          </label>
        </div>
        <div className="max-h-[480px] overflow-auto">
          <FileTree tree={workspace.tree} selected={selected} selectPaths={selectPaths} activePath={null}
            onOpen={path => selectPaths([path], !selected.has(path))} />
        </div>
      </> : <div className="px-6 py-12 text-center text-muted">
        <Workflow size={25} className="mx-auto mb-4 opacity-60" />
        <p className="text-sm">Open a folder, then pick the files to map.</p>
        <p className="text-xs mt-2">Include the entry point (UI, route, CLI) and the modules it calls.</p>
      </div>}
      <div className="p-5 border-t border-line mt-auto">
        <h2 className="eyebrow flex gap-2 items-center mb-4"><History size={13} />Recent flow maps</h2>
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {history.map(item => <div key={item.id} className={`group flex items-start gap-1 rounded-lg hover:bg-elevated ${job?.id === item.id ? 'bg-elevated' : ''}`}>
            <button onClick={() => show(item.id)} className="flex-1 min-w-0 text-left p-3">
              <div className="flex gap-2 items-center">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.status === 'completed' ? 'bg-added' : ['failed', 'cancelled'].includes(item.status) ? 'bg-removed' : 'bg-amber animate-pulse'}`} />
                <span className="truncate text-xs font-medium">{item.title}</span>
              </div>
              <div className="flex justify-between text-[10px] text-muted mt-1 pl-3.5">
                <span>{new Date(item.created_at).toLocaleDateString()} · {item.counts?.files || 0} files</span>
                <span>{item.status === 'completed' ? `${item.counts?.nodes || 0} steps` : item.status}</span>
              </div>
            </button>
            {!['queued', 'running'].includes(item.status) && <button className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5 mr-1" title="Delete" aria-label="Delete flow map" onClick={() => remove(item.id)}><Trash2 size={13} /></button>}
          </div>)}
          {!history.length && <p className="text-xs text-muted">Generated flow maps are saved here.</p>}
        </div>
      </div>
    </aside>

    <main className="p-5 lg:p-8 xl:p-10 min-w-0 max-w-[1600px] w-full mx-auto">
      <div className="flex flex-wrap justify-between items-start gap-5 mb-7">
        <div>
          <p className="eyebrow">From input to output</p>
          <TabTitle icon={Workflow} name="QuFlow" tone="teal" />
          <p className="text-sm text-muted mt-2">See where each step happens: which file runs, which service it calls, and what comes out.</p>
        </div>
        <div
          className="flow-switch shrink-0"
          role="tablist"
          aria-label="QuFlow views"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'flow'}
            className={view === 'flow' ? 'on' : ''}
            onClick={() => onViewChange?.('flow')}
          >
            Flow map
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'uml'}
            className={view === 'uml' ? 'on' : ''}
            onClick={() => onViewChange?.('uml')}
          >
            UML diagrams
          </button>
        </div>
      </div>

      {view === 'uml' ? (
        <UmlView
          open={umlOpen}
          light={light}
          onError={onError}
          onBack={() => onViewChange?.('flow')}
        />
      ) : (
        <>
      <section className="card p-5 mb-6">
        <div className="grid xl:grid-cols-[minmax(0,1fr)_260px] gap-5">
          <div>
            <label htmlFor="flow-focus" className="eyebrow block mb-3">02 / What to trace (optional)</label>
            <textarea id="flow-focus" className="input min-h-[74px] resize-y" maxLength={2000} value={focus} onChange={e => setFocus(e.target.value)}
              placeholder="For example: trace what happens when a user uploads a document, from the API route to the stored result." />
          </div>
          <div>
            <p className="eyebrow mb-3">03 / Detail</p>
            <div className="grid grid-cols-2 gap-1 bg-ink border border-line p-1 rounded-lg" role="radiogroup" aria-label="Diagram detail">
              {[['overview', 'Overview', '10–22 steps'], ['detailed', 'Detailed', '20–40 steps']].map(([id, label, note]) =>
                <button key={id} role="radio" aria-checked={detail === id} onClick={() => setDetail(id)}
                  className={`rounded-md px-2 py-2 text-left ${detail === id ? 'bg-elevated shadow-xs' : 'text-muted'}`}>
                  <span className="block text-xs font-medium">{label}</span><span className="block text-[10px] text-muted">{note}</span>
                </button>)}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted mt-3">
              <input type="checkbox" checked={reactFlow} onChange={event => setReactFlow(event.target.checked)} aria-label="Use React Flow renderer" />
              Use React Flow <span className="ml-auto text-[10px]">{reactFlow ? 'React Flow' : 'Mermaid (default)'}</span>
            </label>
            <p className="text-[10px] text-muted mt-1">Switch the current map without another model call.</p>
            <button className="btn-primary w-full mt-3" disabled={runStop.stopping || (!busy && !canRun)} onClick={busy ? runStop.stop : generate}>
              {busy ? <Square size={16} /> : <Workflow size={15} />}
              {runStop.stopping ? 'Stopping…' : busy ? 'Stop' : 'Generate flow map'}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-4 mt-4 text-xs text-muted">
          {!selected.size && <span>Select files in the tree to map them.</span>}
          {planBusy && <span className="flex items-center gap-2"><LoaderCircle size={12} className="animate-spin" />Estimating size…</span>}
          {planError && <span className="text-removed">{planError}</span>}
          {plan && !planBusy && <>
            <span>{number(plan.file_count)} files · {number(plan.lines)} lines</span>
            <span>~{number(plan.source_tokens)} source tokens</span>
            <span>{plan.mode === 'single' ? 'One model call' : `${plan.llm_calls} model calls (large selection: files are summarised first)`}</span>
            {plan.split_files?.length > 0 && <span className="text-amber">{plan.split_files.length} large file(s) read in parts</span>}
          </>}
        </div>
        {!settings?.configured && <button className="text-xs text-amber mt-3 flex items-center gap-2" onClick={onConfigure}>
          <KeyRound size={13} />Add the endpoint, API key and deployment for {settings?.active?.label || 'the active provider'}.
        </button>}
      </section>

      <FlowResult job={job} light={light} reactFlow={reactFlow} hover={hover} setHover={setHover} pinned={pinned} setPinned={setPinned} nodeId={nodeId} setNodeId={setNodeId} />
        </>
      )}
    </main>
  </div>
}

const summary = job => ({ id: job.id, kind: job.kind, status: job.status, stage: job.stage, created_at: job.created_at,
  title: job.title, counts: job.counts, error: job.error })

function FlowResult({ job, light, reactFlow, hover, setHover, pinned, setPinned, nodeId, setNodeId }) {
  const graph = job?.graph
  const nodes = useMemo(() => Object.fromEntries((graph?.nodes || []).map(n => [n.id, n])), [graph])
  const byFile = useMemo(() => {
    const groups = {}
    for (const node of graph?.nodes || []) (groups[node.file || ''] ||= []).push(node)
    return Object.entries(groups).sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b))
  }, [graph])
  const kindsUsed = useMemo(() => Object.keys(KINDS).filter(kind => graph?.nodes.some(n => n.kind === kind)), [graph])

  if (!job) return <div className="card min-h-[380px] flex flex-col items-center justify-center text-center px-8">
    <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5 mb-5"><Workflow size={34} className="text-sky-400" /></div>
    <h2 className="text-xl font-semibold">Map how your code flows</h2>
    <p className="text-muted max-w-md text-sm mt-3 leading-relaxed">Select the files that make up a feature or service. QuCoRe traces the path from input to output and draws it as a diagram with a step-by-step summary.</p>
    <div className="mt-7 flex flex-wrap justify-center gap-3"><span className="pill">Zoom and pan</span><span className="pill">PNG and SVG export</span><span className="pill">Mermaid source</span></div>
  </div>
  if (['queued', 'running'].includes(job.status)) return <div role="status" className="card p-12 flex flex-col items-center justify-center min-h-[380px] text-center">
    <BrandLoader className="brand-loader-inline mb-6" />
    <h2 className="text-xl font-semibold">{job.stage || 'Preparing'}</h2>
    <p className="text-muted text-sm mt-3 max-w-md">Reading {job.counts?.files} files and tracing the flow. The map appears here and is saved automatically.</p>
  </div>
  if (job.status === 'cancelled') return <div role="status" className="card p-8"><h2 className="text-xl font-semibold">Flow map stopped</h2><p className="text-sm text-muted mt-3">{job.error}</p></div>
  if (job.status === 'failed' || !graph) return <div role="alert" className="card border-removed/30 p-8">
    <AlertTriangle className="text-removed mb-4" />
    <h2 className="text-xl font-semibold">The flow map could not be built</h2>
    <p className="text-sm text-muted mt-3">{job.error || 'No diagram data was returned.'}</p>
    <p className="text-sm text-muted mt-3">Adjust the selection or the model settings, then generate it again.</p>
  </div>

  const highlight = (hover ?? pinned)?.nodes || []
  const node = nodeId ? nodes[nodeId] : null
  const incoming = node ? graph.edges.filter(e => e.to === node.id) : []
  const outgoing = node ? graph.edges.filter(e => e.from === node.id) : []
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ title: graph.title, created_at: job.created_at, files: job.files, graph }, null, 2)], { type: 'application/json' }))
    Object.assign(document.createElement('a'), { href: url, download: `flow-map-${job.id.slice(0, 12)}.json` }).click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const overlay = node && <div className="flow-overlay" role="dialog" aria-label={`Details for ${node.label}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="flow-kind" style={{ '--kind': KINDS[node.kind]?.[light ? 'light' : 'dark'][1] }}>{KINDS[node.kind]?.label}</span>
        <h3 className="text-sm font-semibold mt-1.5">{node.label}</h3>
      </div>
      <button className="btn-icon p-1!" onClick={() => setNodeId(null)} aria-label="Close details"><X size={15} /></button>
    </div>
    {node.file && <p className="font-mono text-[11px] text-sky-400 break-all mt-2">{node.file}</p>}
    {node.detail && <p className="text-xs leading-5 text-fg/85 mt-2"><InlineCode text={node.detail} /></p>}
    {(incoming.length > 0 || outgoing.length > 0) && <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-line text-[11px]">
      <div><p className="text-muted mb-1">Comes from</p>{incoming.map((e, i) => <button key={i} className="flow-link" onClick={() => setNodeId(e.from)}>{nodes[e.from]?.label}{e.label && <span className="text-muted"> · {e.label}</span>}</button>)}{!incoming.length && <span className="text-muted">Start</span>}</div>
      <div><p className="text-muted mb-1">Leads to</p>{outgoing.map((e, i) => <button key={i} className="flow-link" onClick={() => setNodeId(e.to)}>{nodes[e.to]?.label}{e.label && <span className="text-muted"> · {e.label}</span>}</button>)}{!outgoing.length && <span className="text-muted">End</span>}</div>
    </div>}
  </div>

  return <div className="space-y-5">
    <section className="card p-6">
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div className="min-w-0">
          <p className="eyebrow text-added">Flow map ready</p>
          <h2 className="text-2xl font-semibold mt-2">{graph.title}</h2>
          <p className="text-muted text-xs mt-2">{new Date(job.created_at).toLocaleString()} · {job.deployment}{job.provider_label ? ` · ${job.provider_label}` : ''} · {job.counts.files} files · {graph.nodes.length} steps · {graph.edges.length} links</p>
        </div>
        <button className="btn" onClick={exportJson}><FileJson size={15} />JSON</button>
      </div>
      {graph.overview && <p className="text-sm leading-7 text-fg/85 mt-4 max-w-4xl"><InlineCode text={graph.overview} /></p>}
    </section>

    <section className="card overflow-hidden">
      {reactFlow ? <RendererBoundary key={`${job.id}-react-flow`}
        fallback={<FlowDiagram graph={graph} light={light} highlight={highlight} selectedId={nodeId} onSelect={setNodeId} overlay={overlay} title={graph.title} />}>
        <Suspense fallback={<BrandLoader className="p-12" label="Loading React Flow…" />}>
          <ReactFlowDiagram graph={graph} light={light} highlight={highlight} selectedId={nodeId} onSelect={setNodeId} overlay={overlay} title={graph.title} />
        </Suspense>
      </RendererBoundary> : <FlowDiagram key={job.id} graph={graph} light={light} highlight={highlight} selectedId={nodeId} onSelect={setNodeId} overlay={overlay} title={graph.title} />}
      <div className="flex flex-wrap gap-x-4 gap-y-2 px-4 py-3 border-t border-line" aria-label="Legend">
        {kindsUsed.map(kind => <span key={kind} className="flex items-center gap-2 text-[11px] text-muted">
          <span className={`flow-swatch flow-swatch-${kind}`} style={{ background: KINDS[kind][light ? 'light' : 'dark'][0], borderColor: KINDS[kind][light ? 'light' : 'dark'][1] }} />{KINDS[kind].label}
        </span>)}
        <span className="flex items-center gap-2 text-[11px] text-muted"><span className="flow-dash" />Async, optional or error path</span>
      </div>
    </section>

    <div className="grid xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-5 items-start">
      <section className="card p-6">
        <h3 className="section-title mb-1">How it flows</h3>
        <p className="text-xs text-muted mb-4">Hover a point to highlight its steps in the diagram; click to keep it highlighted.</p>
        <ul className="space-y-1">
          {graph.steps.map((step, i) => {
            const active = pinned === step
            return <li key={i}>
              <button className={`flow-step ${active ? 'flow-step-on' : ''}`} onMouseEnter={() => setHover(step)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(step)} onBlur={() => setHover(null)} onClick={() => setPinned(active ? null : step)} aria-pressed={active}>
                <span className="flow-step-dot" aria-hidden="true" />
                <span className="text-sm leading-6"><InlineCode text={step.text} /></span>
              </button>
            </li>
          })}
        </ul>
        {!graph.steps.length && <p className="text-sm text-muted">No step summary was returned.</p>}
      </section>
      <section className="card p-6">
        <h3 className="section-title mb-4"><FileCode2 size={17} className="text-sky-400" />Where it happens</h3>
        <div className="space-y-4">
          {byFile.map(([file, items]) => <div key={file || 'none'}>
            <p className={`font-mono text-[11px] break-all ${file ? 'text-fg' : 'text-muted'}`}>{file || 'Outside the selected code'}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {items.map(item => <button key={item.id} onClick={() => setNodeId(item.id)} className={`flow-chip ${nodeId === item.id ? 'flow-chip-on' : ''}`}
                style={{ '--kind': KINDS[item.kind]?.[light ? 'light' : 'dark'][1] }}>{item.label}</button>)}
            </div>
          </div>)}
        </div>
      </section>
    </div>

    {graph.notes?.length > 0 && <section className="card p-6">
      <h3 className="section-title mb-3"><Info size={17} className="text-amber" />Assumptions and gaps</h3>
      <ul className="list-disc pl-5 space-y-1.5 text-sm text-fg/80">{graph.notes.map((note, i) => <li key={i}><InlineCode text={note} /></li>)}</ul>
    </section>}

    <p className="text-[11px] text-muted">
      {number(job.usage?.requests)} model calls · {number(job.usage?.input_tokens)} input / {number(job.usage?.output_tokens)} output tokens · {money(job.cost?.complete ? job.cost?.total_usd : job.cost?.known_subtotal_usd)}{job.cost?.complete ? '' : ' (subtotal)'}.
      Generated from the selected code only; verify important paths against the source.
    </p>
  </div>
}
