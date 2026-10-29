import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlow, ReactFlowProvider, Handle, Position, useReactFlow, useNodesInitialized, useViewport } from '@xyflow/react'
import {
  ArrowDownUp, ArrowLeftRight, Check, ClipboardCopy, FileCode2, ImageDown, LoaderCircle,
  Maximize, Minimize2, Scan, ZoomIn, ZoomOut,
} from 'lucide-react'
import { buildMermaid, FONT, KINDS, THEMES } from '../flowMermaid.js'
import { layoutReactGraph } from '../flowReactLayout.js'
import '@xyflow/react/dist/style.css'
import './ReactFlowDiagram.css'

const slug = value => String(value || 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flow'
const palette = light => THEMES[light ? 'light' : 'dark']

// Pure SVG artwork is shared by React Flow and the full-diagram exports.
// Text is measured before layout, so captions stay inside their boundaries.
function NodeArtwork({ data, light }) {
  const { width: w, height: h, kind, labelLines, fileLines, contentHeight } = data
  const t = palette(light)
  const [fill, stroke] = (KINDS[kind] || KINDS.process)[light ? 'light' : 'dark']
  const style = { fill, stroke, strokeWidth: 1.8 }
  let shape
  if (kind === 'decision') shape = <polygon points={`${w / 2},1 ${w - 1},${h / 2} ${w / 2},${h - 1} 1,${h / 2}`} {...style} />
  else if (kind === 'api') shape = <polygon points={`22,1 ${w - 22},1 ${w - 1},${h / 2} ${w - 22},${h - 1} 22,${h - 1} 1,${h / 2}`} {...style} />
  else if (kind === 'external') shape = <polygon points={`22,1 ${w - 1},1 ${w - 22},${h - 1} 1,${h - 1}`} {...style} />
  else if (kind === 'data') shape = <>
    <path d={`M 1 15 C 1 -3 ${w - 1} -3 ${w - 1} 15 L ${w - 1} ${h - 15} C ${w - 1} ${h + 3} 1 ${h + 3} 1 ${h - 15} Z`} {...style} />
    <path d={`M 1 15 C 1 33 ${w - 1} 33 ${w - 1} 15`} fill="none" stroke={stroke} strokeWidth="1.8" />
  </>
  else shape = <>
    <rect x="1" y="1" width={w - 2} height={h - 2} rx={['input', 'output'].includes(kind) ? Math.min(h / 2, 44) : kind === 'ui' ? 16 : 8} {...style} />
    {kind === 'service' && <path d={`M 9 1 V ${h - 1} M ${w - 9} 1 V ${h - 1}`} stroke={stroke} strokeWidth="1.4" />}
  </>
  const top = (h - contentHeight) / 2
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible', fontFamily: FONT }}>
    <title>{data.label}{data.file ? ` — ${data.file}` : ''}</title>
    {shape}
    <text textAnchor="middle" fill={t.text} fontSize="14" fontWeight="600">
      {labelLines.map((line, i) => <tspan key={i} x={w / 2} y={top + 15 + i * 20}>{line}</tspan>)}
    </text>
    {fileLines.length > 0 && <text textAnchor="middle" fill={t.muted} fontSize="12">
      {fileLines.map((line, i) => <tspan key={i} x={w / 2} y={top + labelLines.length * 20 + 23 + i * 17}>{line}</tspan>)}
    </text>}
  </svg>
}

function GroupArtwork({ data, light }) {
  const t = palette(light)
  return <svg width={data.width} height={data.height} style={{ display: 'block', fontFamily: FONT }}>
    <rect x="1" y="1" width={data.width - 2} height={data.height - 2} rx="18" fill={t.cluster} stroke={t.clusterBorder} strokeWidth="2" />
    <path d={`M 20 ${28 + data.labelLines.length * 18} H ${data.width - 20}`} stroke={t.clusterBorder} />
    <text fill={t.muted} fontSize="13" fontWeight="600">
      {data.labelLines.map((line, i) => <tspan key={i} x="24" y={27 + i * 18}>{line}</tspan>)}
    </text>
  </svg>
}

function EdgeArtwork({ data, light, prefix }) {
  const t = palette(light)
  const marker = `${prefix}-${data.id}`
  return <g opacity={data.dimmed ? 0.24 : 1} style={{ fontFamily: FONT }}>
    <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill={data.focused ? '#3698ef' : t.line} />
    </marker></defs>
    {data.paths.map((path, i) => <path key={i} d={path} fill="none" stroke={data.focused ? '#3698ef' : t.line}
      strokeWidth={data.focused ? 2.8 : 1.7} strokeLinejoin="round"
      strokeDasharray={data.style === 'dashed' ? '7 5' : undefined}
      markerEnd={i === data.paths.length - 1 ? `url(#${marker})` : undefined} />)}
    {data.labelLines.length > 0 && <g>
      <rect x={data.labelX} y={data.labelY} width={data.labelWidth} height={data.labelHeight} rx="5" fill={t.edgeLabel} />
      <text fill={t.muted} fontSize="12" textAnchor="middle">
        {data.labelLines.map((line, i) => <tspan key={i} x={data.labelX + data.labelWidth / 2} y={data.labelY + 17 + i * 17}>{line}</tspan>)}
      </text>
    </g>}
  </g>
}

function StepNode({ data }) {
  return <div className={`qucore-rf-step ${data.focused ? 'is-focused' : ''} ${data.picked ? 'is-picked' : ''}`} style={{ opacity: data.dimmed ? 0.28 : 1 }}>
    <Handle id="in" type="target" position={data.horizontal ? Position.Left : Position.Top} isConnectable={false} />
    <NodeArtwork data={data} light={data.light} />
    <Handle id="out" type="source" position={data.horizontal ? Position.Right : Position.Bottom} isConnectable={false} />
  </div>
}
function GroupNode({ data }) { return <GroupArtwork data={data} light={data.light} /> }
function RoutedEdge({ data }) { return <EdgeArtwork data={data} light={data.light} prefix={data.prefix} /> }
const nodeTypes = { qucoreStep: StepNode, qucoreBoundary: GroupNode }
const edgeTypes = { qucoreRoute: RoutedEdge }

function save(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Diagram({ graph, light, highlight = [], selectedId = null, onSelect, overlay, title }) {
  const [direction, setDirection] = useState('TB')
  const [showFiles, setShowFiles] = useState(true)
  const [orthogonal, setOrthogonal] = useState(true)
  const [layout, setLayout] = useState(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)
  const viewport = useRef(null)
  const copyTimer = useRef(null)
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, '')
  const { fitView, zoomIn, zoomOut, zoomTo, getViewport, setViewport } = useReactFlow()
  const initialized = useNodesInitialized()
  const { zoom } = useViewport()
  const source = useMemo(() => buildMermaid(graph, { direction, showFiles, light }), [graph, direction, showFiles, light])

  useEffect(() => {
    let live = true
    setBusy(true)
    setError('')
    setLayout(null)
    layoutReactGraph(graph, { direction, showFiles, orthogonal })
      .then(value => { if (live) setLayout(value) })
      .catch(err => { if (live) setError(err.message || 'The React Flow layout could not be created. You can switch back to Mermaid.') })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [graph, direction, showFiles, orthogonal])

  const fit = useCallback(() => {
    if (viewport.current?.clientWidth) fitView({ padding: 0.12, minZoom: 0.05, maxZoom: 1.25, duration: 0 })
  }, [fitView])
  useEffect(() => {
    if (!initialized || !layout) return
    const frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [initialized, layout, full, fit])
  useEffect(() => {
    const element = viewport.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (element.clientWidth && element.clientHeight) fit() })
    observer.observe(element)
    return () => observer.disconnect()
  }, [fit])
  useEffect(() => {
    if (!full) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = event => { if (event.key === 'Escape') setFull(false) }
    document.addEventListener('keydown', close)
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', close) }
  }, [full])
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const nodes = useMemo(() => {
    if (!layout) return []
    const focus = new Set([...highlight, ...(selectedId ? [selectedId] : [])])
    return [
      ...layout.groups.map(group => ({ id: group.id, type: 'qucoreBoundary', position: { x: group.x, y: group.y },
        data: { ...group, light }, width: group.width, height: group.height, style: { width: group.width, height: group.height },
        draggable: false, selectable: false, focusable: false, zIndex: -1 })),
      ...layout.nodes.map(node => ({ id: node.id, type: 'qucoreStep', position: node.position, parentId: node.parentId,
        extent: node.parentId ? 'parent' : undefined, width: node.width, height: node.height,
        style: { width: node.width, height: node.height }, zIndex: 2,
        ariaLabel: `${node.label}${node.file ? `, ${node.file}` : ''}`,
        data: { ...node, light, focused: focus.has(node.id), picked: selectedId === node.id, dimmed: focus.size > 0 && !focus.has(node.id) } })),
    ]
  }, [layout, light, highlight, selectedId])
  const edges = useMemo(() => {
    const focus = new Set([...highlight, ...(selectedId ? [selectedId] : [])])
    return (layout?.edges || []).map(edge => ({ id: edge.id, source: edge.from, target: edge.to,
      sourceHandle: 'out', targetHandle: 'in', type: 'qucoreRoute', zIndex: 1, selectable: false,
      data: { ...edge, light, prefix, focused: focus.has(edge.from) && focus.has(edge.to),
        dimmed: focus.size > 0 && !(focus.has(edge.from) && focus.has(edge.to)) } }))
  }, [layout, light, prefix, highlight, selectedId])
  const select = useCallback((event, node) => {
    if (node.type === 'qucoreStep') onSelect?.(node.id === selectedId ? null : node.id)
  }, [onSelect, selectedId])
  const clear = useCallback(() => onSelect?.(null), [onSelect])
  const reportError = useCallback((code, message) => setError(`Diagram: ${message}`), [])

  function keys(event) {
    if (event.target.closest('button, input, select, textarea, .flow-overlay, a')) return
    const current = getViewport()
    const moves = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }
    if (['+', '='].includes(event.key)) zoomIn()
    else if (['-', '_'].includes(event.key)) zoomOut()
    else if (event.key === '0') fit()
    else if (event.key === 'Enter' || event.key === ' ') {
      const id = event.target.closest('.react-flow__node')?.dataset.id
      if (!graph.nodes.some(node => node.id === id)) return
      onSelect?.(id === selectedId ? null : id)
    } else if (moves[event.key]) setViewport({ ...current, x: current.x + moves[event.key][0], y: current.y + moves[event.key][1] })
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  function svgExport() {
    if (!layout) return null
    const t = palette(light)
    const heading = title || graph.title || 'Logical flow'
    const measure = document.createElement('canvas').getContext('2d')
    if (measure) measure.font = `600 18px ${FONT}`
    const width = Math.ceil(Math.max(layout.width + 48, (measure?.measureText(heading).width || heading.length * 18) + 48))
    const height = Math.ceil(layout.height + 100)
    const text = renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <rect width={width} height={height} fill={t.bg} />
      <text x="24" y="30" fill={t.text} fontSize="18" fontWeight="600" fontFamily={FONT}>{title || graph.title || 'Logical flow'}</text>
      <text x="24" y="51" fill={t.muted} fontSize="12" fontFamily={FONT}>QuCoRe flow map · React Flow · {new Date().toLocaleDateString()}</text>
      <g transform="translate(24 76)">
        {layout.groups.map(group => <g key={group.id} transform={`translate(${group.x} ${group.y})`}><GroupArtwork data={group} light={light} /></g>)}
        {layout.edges.map(edge => <EdgeArtwork key={edge.id} data={edge} light={light} prefix="export" />)}
        {layout.nodes.map(node => <g key={node.id} transform={`translate(${node.x} ${node.y})`}><NodeArtwork data={node} light={light} /></g>)}
      </g>
    </svg>)
    return { text, width, height }
  }
  async function download(kind) {
    setExporting(true)
    setError('')
    try {
      const out = svgExport()
      if (!out) return
      const name = `${slug(title || graph.title)}-react-flow`
      if (kind === 'svg') { save(new Blob([out.text], { type: 'image/svg+xml' }), `${name}.svg`); return }
      const image = new Image()
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(out.text)
      await image.decode()
      // Export every node and boundary, independent of current pan/zoom/selection.
      const scale = Math.min(3, 16000 / out.width, 16000 / out.height, Math.sqrt(80e6 / (out.width * out.height)))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(out.width * scale))
      canvas.height = Math.max(1, Math.floor(out.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser could not create a PNG canvas.')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('PNG export failed. Try SVG export instead.')
      save(blob, `${name}.png`)
    } catch (err) { setError(err.message || 'The diagram could not be exported.') }
    finally { setExporting(false) }
  }
  async function copySource() {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch { setError('The browser blocked clipboard access.') }
  }
  const tool = (label, Icon, action) => <button type="button" className="btn-small" title={label} aria-label={label} onClick={action}><Icon size={15} /></button>

  return <div className={`${full ? 'flow-full' : 'flow-frame'} qucore-rf`}>
    <div className="flow-toolbar">
      <div className="flex items-center gap-0.5">
        {tool('Zoom out (-)', ZoomOut, () => zoomOut())}
        <span className="text-[11px] text-muted w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        {tool('Zoom in (+)', ZoomIn, () => zoomIn())}
        {tool('Fit to view (0)', Scan, fit)}
        <button type="button" className="btn-small" onClick={() => zoomTo(1)} title="Actual size">1:1</button>
      </div>
      <span className="flow-sep" />
      <div className="flex items-center gap-1">
        <button type="button" className={`flow-toggle ${direction === 'TB' ? 'flow-toggle-on' : ''}`} onClick={() => setDirection('TB')} aria-pressed={direction === 'TB'}><ArrowDownUp size={13} />Vertical</button>
        <button type="button" className={`flow-toggle ${direction === 'LR' ? 'flow-toggle-on' : ''}`} onClick={() => setDirection('LR')} aria-pressed={direction === 'LR'}><ArrowLeftRight size={13} />Horizontal</button>
        <button type="button" className={`flow-toggle ${showFiles ? 'flow-toggle-on' : ''}`} onClick={() => setShowFiles(!showFiles)} aria-pressed={showFiles}><FileCode2 size={13} />File names</button>
        <select className="flow-select" value={orthogonal ? 'orthogonal' : 'standard'} onChange={event => setOrthogonal(event.target.value === 'orthogonal')} aria-label="Layout style">
          <option value="standard">Standard layout</option><option value="orthogonal">Orthogonal layout</option>
        </select>
      </div>
      <div className="flex items-center gap-1 ml-auto">
        <button type="button" className="btn-small" onClick={copySource} title="Copy equivalent Mermaid source">{copied ? <Check size={14} /> : <ClipboardCopy size={14} />}Mermaid</button>
        <button type="button" className="btn-small" onClick={() => download('svg')} disabled={!layout || busy || exporting}>SVG</button>
        <button type="button" className="btn-primary py-1.5! px-3! text-xs!" onClick={() => download('png')} disabled={!layout || busy || exporting}><ImageDown size={14} />PNG</button>
        {tool(full ? 'Exit full screen (Esc)' : 'Full screen', full ? Minimize2 : Maximize, () => setFull(!full))}
      </div>
    </div>
    {error && <p role="alert" className="px-4 py-3 text-xs text-removed border-b border-line">{error}</p>}
    <div ref={viewport} className="flow-viewport qucore-rf-viewport" tabIndex={0} onKeyDownCapture={keys}
      aria-label="React Flow diagram. Drag to pan, plus and minus to zoom, 0 to fit, Enter to inspect a focused step.">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable={false}
        nodesFocusable edgesFocusable={false} deleteKeyCode={null} selectionKeyCode={null}
        minZoom={0.05} maxZoom={4} panOnDrag zoomOnScroll={full} zoomOnPinch zoomOnDoubleClick={false}
        zoomActivationKeyCode={['Control', 'Meta']} preventScrolling={full}
        onNodeClick={select} onPaneClick={clear} onError={reportError}
        colorMode={light ? 'light' : 'dark'} style={{ background: palette(light).bg }}>
      </ReactFlow>
      {busy && <div className="flow-status"><LoaderCircle size={16} className="animate-spin" />Laying out the diagram…</div>}
      {overlay}
      <p className="flow-hint">React Flow · {full ? 'Scroll to zoom' : 'Ctrl + scroll to zoom'} · drag to pan · click a box for details</p>
    </div>
  </div>
}

export default function ReactFlowDiagram(props) {
  return <ReactFlowProvider><Diagram {...props} /></ReactFlowProvider>
}
