import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, Handle, Position, ReactFlow } from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { LoaderCircle } from 'lucide-react'
import '@xyflow/react/dist/style.css'

// UML class / object / sequence diagrams drawn with React Flow. Class and object boxes have attribute and method
// compartments; relations use UML arrowheads. Sequence diagrams are laid out by hand (lifelines + message arrows).

const SIDES = [['top', Position.Top], ['bottom', Position.Bottom], ['left', Position.Left], ['right', Position.Right]]
const Handles = () => SIDES.flatMap(([id, position]) => [
  <Handle key={`${id}s`} id={`${id}-s`} type="source" position={position} className="uml-handle" isConnectable={false} />,
  <Handle key={`${id}t`} id={`${id}-t`} type="target" position={position} className="uml-handle" isConnectable={false} />,
])

function ClassNode({ data }) {
  return <div className={`uml-class ${data.object ? 'uml-object' : ''}`} style={{ width: data.w }}>
    <Handles />
    <div className="uml-class-head">
      {data.stereotype && <span className="uml-stereo">«{data.stereotype}»</span>}
      <span className={`uml-class-name ${data.stereotype === 'abstract' ? 'italic' : ''} ${data.object ? 'underline' : ''}`}>{data.name}</span>
      {data.file && <span className="uml-file">{data.file}</span>}
    </div>
    {data.attributes.length > 0 && <ul className="uml-compartment">{data.attributes.map((a, i) => <li key={i}>{a}</li>)}</ul>}
    {data.methods.length > 0 && <ul className="uml-compartment">{data.methods.map((m, i) => <li key={i}>{m}</li>)}</ul>}
  </div>
}
const SeqHead = ({ data }) => <div className={`uml-seq-head uml-seq-${data.kind}`}>{data.kind === 'actor' ? '🧍 ' : data.kind === 'database' ? '🗄 ' : ''}{data.label}</div>
const SeqLine = () => <div className="uml-seq-line" />
const SeqDot = () => <div className="uml-seq-dot">{['l', 'r'].flatMap(side => [
  <Handle key={`${side}s`} id={`${side}-s`} type="source" position={side === 'l' ? Position.Left : Position.Right} className="uml-handle" isConnectable={false} />,
  <Handle key={`${side}t`} id={`${side}-t`} type="target" position={side === 'l' ? Position.Left : Position.Right} className="uml-handle" isConnectable={false} />,
])}</div>
const nodeTypes = { umlClass: ClassNode, seqHead: SeqHead, seqLine: SeqLine, seqDot: SeqDot }

const EDGE_STYLE = {
  inherits: { markerEnd: 'uml-tri' }, implements: { markerEnd: 'uml-tri', dashed: true }, composes: { markerStart: 'uml-dia-fill' },
  aggregates: { markerStart: 'uml-dia-open' }, associates: { markerEnd: 'uml-arrow' }, depends: { markerEnd: 'uml-arrow', dashed: true },
}
const edgeLook = dashed => ({ style: { stroke: 'rgb(var(--muted))', strokeWidth: 1.5, ...(dashed ? { strokeDasharray: '6 5' } : {}) },
  labelStyle: { fill: 'rgb(var(--fg))', fontSize: 11 }, labelBgStyle: { fill: 'rgb(var(--panel))', fillOpacity: 0.92 }, labelBgPadding: [5, 3], labelBgBorderRadius: 4 })

function classSize(c) {
  const lines = [c.name, c.stereotype ? `«${c.stereotype}»` : '', ...c.attributes, ...c.methods]
  const w = Math.min(380, Math.max(170, Math.max(...lines.map(l => l.length)) * 7.3 + 30))
  const h = 40 + (c.stereotype ? 16 : 0) + (c.file ? 14 : 0) + (c.attributes.length ? 12 + c.attributes.length * 18 : 0) + (c.methods.length ? 12 + c.methods.length * 18 : 0)
  return { w, h }
}

async function layoutClasses(spec) {
  const items = spec.diagram === 'object'
    ? spec.objects.map(o => ({ id: o.id, name: `${o.name}${o.class ? ' : ' + o.class : ''}`, stereotype: '', file: '', attributes: o.fields, methods: [], object: true }))
    : spec.classes
  const relations = spec.diagram === 'object' ? spec.links.map(l => ({ ...l, type: 'associates' })) : spec.relations
  const sized = items.map(c => ({ ...c, ...classSize(c) }))
  const elk = new ELK()
  const result = await elk.layout({
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.spacing.nodeNode': '56', 'elk.layered.spacing.nodeNodeBetweenLayers': '84', 'elk.edgeRouting': 'ORTHOGONAL' },
    children: sized.map(c => ({ id: c.id, width: c.w, height: c.h })),
    // parents above children: inheritance and implementation edges point from the general class down to the specific one
    edges: relations.map((r, i) => (['inherits', 'implements'].includes(r.type) ? { id: `e${i}`, sources: [r.to], targets: [r.from] } : { id: `e${i}`, sources: [r.from], targets: [r.to] })),
  })
  const at = Object.fromEntries((result.children || []).map(c => [c.id, c]))
  const nodes = sized.map(c => ({ id: c.id, type: 'umlClass', position: { x: at[c.id]?.x || 0, y: at[c.id]?.y || 0 },
    data: { name: c.name, stereotype: c.stereotype, file: c.file, attributes: c.attributes, methods: c.methods, object: c.object, w: c.w }, width: c.w, height: c.h }))
  const centre = id => ({ x: (at[id]?.x || 0) + (at[id]?.width || 0) / 2, y: (at[id]?.y || 0) + (at[id]?.height || 0) / 2 })
  const edges = relations.map((r, i) => {
    const a = centre(r.from), b = centre(r.to)
    const dx = b.x - a.x, dy = b.y - a.y
    const vertical = Math.abs(dy) >= Math.abs(dx) * 0.5
    const [sh, th] = vertical ? (dy >= 0 ? ['bottom-s', 'top-t'] : ['top-s', 'bottom-t']) : (dx >= 0 ? ['right-s', 'left-t'] : ['left-s', 'right-t'])
    const look = EDGE_STYLE[r.type] || EDGE_STYLE.associates
    return { id: `r${i}`, source: r.from, target: r.to, sourceHandle: sh, targetHandle: th, type: 'smoothstep', label: r.label || '',
      markerStart: look.markerStart, markerEnd: look.markerEnd, ...edgeLook(look.dashed) }
  })
  return { nodes, edges }
}

function layoutSequence(spec) {
  const col = 210, headW = 160, headH = 42, step = 56
  const index = Object.fromEntries(spec.participants.map((p, i) => [p.id, i]))
  const cx = id => index[id] * col + headW / 2
  const height = (spec.messages.length + 1) * step + 30
  const nodes = []
  spec.participants.forEach((p, i) => {
    nodes.push({ id: `head-${p.id}`, type: 'seqHead', position: { x: i * col, y: 0 }, data: { label: p.label, kind: p.kind }, draggable: false, selectable: false, width: headW, height: headH })
    nodes.push({ id: `line-${p.id}`, type: 'seqLine', position: { x: cx(p.id) - 1, y: headH }, data: {}, draggable: false, selectable: false, zIndex: -1, width: 2, height })
  })
  const edges = []
  spec.messages.forEach((m, k) => {
    const y = headH + 28 + k * step
    const self = m.from === m.to
    nodes.push({ id: `a${k}`, type: 'seqDot', position: { x: cx(m.from) - 4, y }, data: {}, draggable: false, selectable: false, width: 8, height: 8 })
    nodes.push({ id: `b${k}`, type: 'seqDot', position: { x: cx(m.to) - 4, y: self ? y + 24 : y }, data: {}, draggable: false, selectable: false, width: 8, height: 8 })
    const right = cx(m.to) >= cx(m.from)
    edges.push({ id: `m${k}`, source: `a${k}`, target: `b${k}`, type: self ? 'step' : 'straight', label: `${k + 1}. ${m.text}`,
      sourceHandle: self || right ? 'r-s' : 'l-s', targetHandle: self ? 'r-t' : right ? 'l-t' : 'r-t',
      markerEnd: m.kind === 'return' || m.kind === 'async' ? 'uml-arrow' : 'uml-solid-arrow', ...edgeLook(m.kind === 'return') })
  })
  return { nodes, edges }
}

const MARKERS = <svg width="0" height="0" className="uml-defs" aria-hidden="true"><defs>
  <marker id="uml-tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="13" markerHeight="13" orient="auto-start-reverse"><path d="M1 1 L11 6 L1 11 z" className="uml-mk-open" /></marker>
  <marker id="uml-arrow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1 1.5 L11 6 L1 10.5" className="uml-mk-line" /></marker>
  <marker id="uml-solid-arrow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1 1 L11 6 L1 11 z" className="uml-mk-fill" /></marker>
  <marker id="uml-dia-fill" viewBox="0 0 16 12" refX="1" refY="6" markerWidth="16" markerHeight="13" orient="auto-start-reverse"><path d="M1 6 L8 1 L15 6 L8 11 z" className="uml-mk-fill" /></marker>
  <marker id="uml-dia-open" viewBox="0 0 16 12" refX="1" refY="6" markerWidth="16" markerHeight="13" orient="auto-start-reverse"><path d="M1 6 L8 1 L15 6 L8 11 z" className="uml-mk-open" /></marker>
</defs></svg>

export default function UmlReactFlow({ spec, light }) {
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setGraph(null); setError('')
    const job = spec.diagram === 'sequence' ? Promise.resolve(layoutSequence(spec)) : layoutClasses(spec)
    job.then(result => live && setGraph(result)).catch(err => live && setError(err?.message || 'The diagram could not be laid out.'))
    return () => { live = false }
  }, [spec])
  const sequence = spec.diagram === 'sequence'
  const content = useMemo(() => graph && <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} colorMode={light ? 'light' : 'dark'}
    fitView fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }} minZoom={0.1} maxZoom={2.5} nodesConnectable={false} nodesDraggable={!sequence}
    elementsSelectable={!sequence} proOptions={{ hideAttribution: false }}>
    <Background gap={22} /><Controls showInteractive={false} />
  </ReactFlow>, [graph, light, sequence])
  return <div className="flow-frame">
    <div className="flow-toolbar"><span className="text-[11px] text-muted">React Flow · drag boxes to rearrange · scroll to zoom. Use the Mermaid view to download PNG or SVG.</span></div>
    <div className="flow-viewport uml-rf" style={{ cursor: 'default' }}>
      {MARKERS}
      {!graph && !error && <div className="flow-status"><LoaderCircle size={16} className="animate-spin" />Laying out the diagram…</div>}
      {error && <div className="flow-status text-removed px-6 text-center">{error}</div>}
      {content}
    </div>
  </div>
}
