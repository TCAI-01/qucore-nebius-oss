import { Component, lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Boxes, FileJson, GitBranch, History, Info, LoaderCircle, Network, Share2, Square, Trash2, Workflow,
} from 'lucide-react'
import { api } from '../api.js'
import FlowDiagram from './FlowDiagram.jsx'
import UmlMermaid from './UmlMermaid.jsx'
import { DIAGRAM_LABELS, GRAPH_TYPES, specToGraph, specToMermaid } from '../uml.js'
import BrandLoader from './BrandLoader.jsx'

const ReactFlowDiagram = lazy(() => import('./ReactFlowDiagram.jsx'))
const UmlReactFlow = lazy(() => import('./UmlReactFlow.jsx'))
const ICONS = { class: Boxes, sequence: Share2, activity: Workflow, state: GitBranch, usecase: Network, object: Boxes }
const active = status => ['queued', 'running'].includes(status)

class Boundary extends Component {
  state = { failed: null }
  static getDerivedStateFromError(error) { return { failed: error } }
  render() {
    return this.state.failed ? <div role="alert" className="p-8 text-sm text-removed flex gap-2"><AlertTriangle size={16} className="shrink-0 mt-0.5" />
      This renderer could not draw the diagram ({this.state.failed.message}). Try the other renderer.</div> : this.props.children
  }
}

// The UML tab of the Flow section. `open` = { id, renderers: { mermaid, reactflow }, nonce } comes from Solidify's links.
export default function UmlView({ open, light, onError, onBack }) {
  const [history, setHistory] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [job, setJob] = useState(null)
  const [renderers, setRenderers] = useState({ mermaid: true, reactflow: false })
  const [view, setView] = useState('mermaid')
  const [stopping, setStopping] = useState(false)

  useEffect(() => { api.umlJobs().then(setHistory).catch(() => {}) }, [])
  useEffect(() => {
    if (!open?.id) return
    setCurrentId(open.id); setJob(null); setStopping(false)
    if (open.renderers) {
      // one renderer at a time (Mermaid unless React Flow alone was chosen)
      const flow = Boolean(open.renderers.reactflow) && !open.renderers.mermaid
      const next = { mermaid: !flow, reactflow: flow }
      setRenderers(next); setView(flow ? 'reactflow' : 'mermaid')
    }
  }, [open?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!currentId) return undefined
    let stopped = false
    let timer
    async function poll() {
      try {
        const next = await api.umlJob(currentId)
        if (stopped) return
        setJob(next)
        setHistory(items => [{ id: next.id, status: next.status, title: next.title, created_at: next.created_at, counts: next.counts }, ...items.filter(i => i.id !== next.id)])
        if (!active(next.status)) { setStopping(false); return }
      } catch (err) { if (!stopped) { onError(err.message); return } }
      if (!stopped) timer = setTimeout(poll, 1300)
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [currentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const spec = job?.spec
  const graph = useMemo(() => (spec && GRAPH_TYPES.has(spec.diagram) ? specToGraph(spec) : null), [spec])
  const source = useMemo(() => (spec && !GRAPH_TYPES.has(spec.diagram) ? specToMermaid(spec) : ''), [spec])
  const both = renderers.mermaid && renderers.reactflow
  const shown = both ? view : renderers.reactflow ? 'reactflow' : 'mermaid'

  function toggle(key) {
    // Exactly one renderer: checking one unchecks the other.
    setRenderers({ mermaid: key === 'mermaid', reactflow: key === 'reactflow' })
    setView(key)
  }
  async function remove(id) {
    try { await api.umlDelete(id); setHistory(items => items.filter(i => i.id !== id)); if (currentId === id) { setCurrentId(null); setJob(null) } } catch (err) { onError(err.message) }
  }
  async function stop() { setStopping(true); try { await api.umlStop(currentId) } catch (err) { setStopping(false); onError(err.message) } }
  function exportJson() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }))
    Object.assign(document.createElement('a'), { href: url, download: `uml-${spec.diagram}.json` }).click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const fallback = <BrandLoader className="p-12" label="Loading the renderer…" />
  return <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[350px_minmax(0,1fr)] min-h-[calc(100vh-150px)]">
    <aside className="bg-panel border-r border-line p-5 min-w-0">
      <button type="button" className="btn w-full" onClick={onBack}><Workflow size={15} />Back to Flow map</button>
      <p className="eyebrow mt-6 mb-3 flex items-center gap-2"><History size={13} />UML diagrams</p>
      <div className="space-y-1 max-h-[60vh] overflow-y-auto">
        {history.map(item => { const Icon = ICONS[item.counts?.diagram] || Boxes; return <div key={item.id} className={`group flex items-start gap-1 rounded-lg hover:bg-elevated ${currentId === item.id ? 'bg-elevated' : ''}`}>
          <button type="button" onClick={() => { setCurrentId(item.id); setJob(null) }} className="flex-1 min-w-0 text-left p-3">
            <span className="flex gap-2 items-center"><Icon size={13} className="text-sky-400 shrink-0" /><span className="truncate text-xs font-medium">{item.title}</span></span>
            <span className="flex justify-between text-[10px] text-muted mt-1 pl-5"><span>{new Date(item.created_at).toLocaleDateString()}</span>
              <span className={item.status === 'failed' ? 'text-removed' : ''}>{item.status === 'completed' ? `${item.counts?.elements || 0} elements` : item.status}</span></span>
          </button>
          {!active(item.status) && <button type="button" className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5 mr-1" title="Delete" aria-label="Delete diagram" onClick={() => remove(item.id)}><Trash2 size={13} /></button>}
        </div> })}
        {!history.length && <p className="text-xs text-muted leading-relaxed">No diagrams yet. Open a Solidify review and use its UML section to draw one from your code.</p>}
      </div>
    </aside>

    <main className="p-5 lg:p-8 min-w-0">
      {!currentId && <div className="card min-h-[340px] flex flex-col items-center justify-center text-center px-8">
        <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5 mb-5"><Boxes size={34} className="text-sky-400" /></div>
        <h2 className="text-xl font-semibold">UML diagrams</h2>
        <p className="text-muted max-w-md text-sm mt-3 leading-relaxed">Class, sequence, activity, state, use case and object diagrams are drawn from your code. Start one from the UML section of a Solidify review, then it opens here.</p>
      </div>}
      {currentId && !job && <div className="card p-10"><BrandLoader label="Loading…" /></div>}
      {job && active(job.status) && <div role="status" className="card p-10 flex flex-col items-center text-center min-h-[300px] justify-center">
        <BrandLoader className="brand-loader-inline mb-5" />
        <h2 className="text-xl font-semibold">{job.stage || 'Preparing'}</h2>
        <p className="text-muted text-sm mt-3 max-w-md">Drawing the {DIAGRAM_LABELS[job.options?.diagram]?.toLowerCase()} from {job.files?.length} file(s). It appears here when it is ready.</p>
        <button type="button" className="btn-primary mt-6" onClick={stop} disabled={stopping}>{stopping ? <LoaderCircle size={15} className="animate-spin" /> : <Square size={14} />}{stopping ? 'Stopping…' : 'Stop'}</button>
      </div>}
      {job && !active(job.status) && !spec && <div role="alert" className={`card p-8 ${job.status === 'cancelled' ? 'border-amber/30' : 'border-removed/30'}`}>
        <AlertTriangle className={`${job.status === 'cancelled' ? 'text-amber' : 'text-removed'} mb-4`} />
        <h2 className="text-xl font-semibold">{job.status === 'cancelled' ? 'Stopped' : 'The diagram could not be drawn'}</h2>
        <p className="text-sm text-muted mt-3">{job.error || 'No diagram was produced.'}</p>
      </div>}

      {spec && <div className="space-y-4">
        <section className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow">{DIAGRAM_LABELS[spec.diagram]} · from {job.files.length} file(s)</p>
              <h2 className="text-xl font-semibold mt-1">{spec.title}</h2>
              {spec.description && <p className="text-sm text-fg/85 mt-2 max-w-3xl leading-6">{spec.description}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <fieldset className="flex items-center gap-3 text-xs" aria-label="Diagram renderer">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={renderers.mermaid} onChange={() => toggle('mermaid')} />Mermaid</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={renderers.reactflow} onChange={() => toggle('reactflow')} />React Flow</label>
              </fieldset>
              <button type="button" className="btn-small" onClick={exportJson}><FileJson size={14} />JSON</button>
            </div>
          </div>
          {both && <div className="chg-seg mt-4 w-fit" role="tablist"><button type="button" role="tab" className={view === 'mermaid' ? 'on' : ''} aria-selected={view === 'mermaid'} onClick={() => setView('mermaid')}>Mermaid</button>
            <button type="button" role="tab" className={view === 'reactflow' ? 'on' : ''} aria-selected={view === 'reactflow'} onClick={() => setView('reactflow')}>React Flow</button></div>}
        </section>
        <section className="card overflow-hidden">
          <Boundary key={`${job.id}-${shown}`}>
            {shown === 'mermaid'
              ? (graph ? <FlowDiagram key={job.id} graph={graph} light={light} highlight={[]} selectedId={null} onSelect={() => {}} title={spec.title} />
                : <UmlMermaid key={job.id} source={source} light={light} title={spec.title} />)
              : <Suspense fallback={fallback}>{graph
                ? <ReactFlowDiagram key={job.id} graph={graph} light={light} highlight={[]} selectedId={null} onSelect={() => {}} title={spec.title} />
                : <UmlReactFlow key={job.id} spec={spec} light={light} />}</Suspense>}
          </Boundary>
        </section>
        {spec.notes?.length > 0 && <section className="card p-5"><p className="eyebrow mb-2 flex items-center gap-2"><Info size={13} />Notes</p>
          <ul className="list-disc pl-5 space-y-1 text-sm text-fg/85">{spec.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></section>}
        <p className="text-[11px] text-muted">Drawn by the model from the code and tool-computed structure facts: check names and relationships against the source. {job.usage ? `${Number(job.usage.input_tokens).toLocaleString()} in / ${Number(job.usage.output_tokens).toLocaleString()} out tokens.` : ''}</p>
      </div>}
    </main>
  </div>
}
