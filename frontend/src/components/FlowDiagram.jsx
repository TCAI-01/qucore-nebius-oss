import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownUp, ArrowLeftRight, Check, ClipboardCopy, FileCode2, ImageDown, LoaderCircle, Maximize, Minimize2,
  Scan, ZoomIn, ZoomOut,
} from 'lucide-react'
import { buildMermaid, fileCaptions, FONT, mermaidConfig, THEMES, wrap } from '../flowMermaid.js'

// Mermaid (and the ELK layout engine) load only when a diagram is first shown.
let loader
function loadMermaid() {
  loader ??= Promise.all([import('mermaid'), import('@mermaid-js/layout-elk')]).then(([m, elk]) => {
    m.default.registerLayoutLoaders(elk.default)
    return m.default
  })
  return loader
}
// mermaid.render is not re-entrant: queue renders.
let queue = Promise.resolve()
let renderCount = 0
function renderMermaid(config, text) {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid()
    mermaid.initialize(config)
    const id = `qflow${++renderCount}`
    try {
      return (await mermaid.render(id, text)).svg
    } finally {
      document.getElementById(id)?.remove()
      document.getElementById('d' + id)?.remove()
    }
  })
  queue = job.catch(() => {})
  return job
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
const nodeIdOf = element => {
  const g = element?.closest?.('g.node')
  const match = g?.id?.match(/(N\d+)(?:-\d+)?$/)
  return match ? match[1] : null
}
const slug = text => String(text || 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flow'

export default function FlowDiagram({ graph, light, highlight = [], selectedId = null, onSelect, overlay, title }) {
  const [direction, setDirection] = useState('TB')
  const [showFiles, setShowFiles] = useState(true)
  const [layout, setLayout] = useState('dagre')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)
  const viewport = useRef(null)
  const stage = useRef(null)
  const view = useRef({ x: 0, y: 0, k: 1 })
  const size = useRef({ w: 0, h: 0 })
  const drag = useRef(null)

  const source = useMemo(() => buildMermaid(graph, { direction, showFiles, light }), [graph, direction, showFiles, light])

  useEffect(() => {
    let live = true
    setBusy(true)
    setError('')
    const config = { ...mermaidConfig(light), layout, elk: { nodePlacementStrategy: 'NETWORK_SIMPLEX', mergeEdges: false } }
    renderMermaid(config, source)
      .then(result => { if (live) setSvg(result) })
      .catch(err => {
        if (!live) return
        if (layout === 'elk') setLayout('dagre') // fall back to the standard layout engine
        else setError(err?.message || 'The diagram could not be rendered.')
      })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [source, layout, light])

  const apply = useCallback(() => {
    const { x, y, k } = view.current
    if (stage.current) stage.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    setZoom(k)
  }, [])

  const fit = useCallback(() => {
    const box = viewport.current?.getBoundingClientRect()
    const { w, h } = size.current
    if (!box || !w || !h) return
    const k = Math.min(Math.max(Math.min((box.width - 48) / w, (box.height - 48) / h, 1.25), MIN_ZOOM), MAX_ZOOM)
    view.current = { k, x: (box.width - w * k) / 2, y: Math.max(24, (box.height - h * k) / 2) }
    apply()
  }, [apply])

  const zoomAt = useCallback((factor, cx, cy) => {
    const box = viewport.current?.getBoundingClientRect()
    if (!box) return
    const { x, y, k } = view.current
    const next = Math.min(Math.max(k * factor, MIN_ZOOM), MAX_ZOOM)
    const px = cx ?? box.width / 2
    const py = cy ?? box.height / 2
    view.current = { k: next, x: px - (px - x) * (next / k), y: py - (py - y) * (next / k) }
    apply()
  }, [apply])

  // Size the SVG to its natural size, mark nodes, and de-emphasise file captions.
  useLayoutEffect(() => {
    const element = stage.current?.querySelector('svg')
    if (!element) return
    const box = element.viewBox?.baseVal
    const w = box?.width || element.getBBox().width
    const h = box?.height || element.getBBox().height
    element.setAttribute('width', w)
    element.setAttribute('height', h)
    element.style.maxWidth = 'none'
    size.current = { w, h }
    const captions = fileCaptions(graph.nodes)
    const byId = Object.fromEntries(graph.nodes.map(n => [n.id, n]))
    const muted = light ? THEMES.light.muted : THEMES.dark.muted
    element.querySelectorAll('g.node').forEach(g => {
      const node = byId[nodeIdOf(g)]
      if (!node) return
      g.dataset.node = node.id
      g.setAttribute('tabindex', '0')
      g.setAttribute('role', 'button')
      g.setAttribute('aria-label', `${node.label}${node.file ? `, ${node.file}` : ''}`)
      if (showFiles && node.file) {
        const rows = [...g.querySelectorAll('text tspan.row, text tspan.text-outer-tspan')]
        const count = wrap(captions[node.file] || node.file, 28).length
        // Row offsets are in em: pin them to pixels at the label size first, so a
        // smaller caption keeps its position instead of sliding into the label.
        const base = parseFloat(getComputedStyle(rows[0] || g).fontSize) || 14
        const px = value => (/em$/.test(value || '') ? `${parseFloat(value) * base}px` : value)
        rows.forEach(row => ['y', 'dy'].forEach(attr => row.hasAttribute(attr) && row.setAttribute(attr, px(row.getAttribute(attr)))))
        rows.slice(-count).forEach(row => {
          row.setAttribute('font-size', '12px')
          row.style.fontSize = '12px'
          row.style.fill = muted
        })
      }
    })
    fit()
  }, [svg]) // eslint-disable-line react-hooks/exhaustive-deps

  // Step / node highlighting.
  useEffect(() => {
    const element = stage.current?.querySelector('svg')
    if (!element) return
    const set = new Set([...highlight, ...(selectedId ? [selectedId] : [])])
    element.classList.toggle('flow-focus', set.size > 0)
    element.querySelectorAll('g.node').forEach(g => {
      g.classList.toggle('flow-hl', set.has(g.dataset.node))
      g.classList.toggle('flow-selected', g.dataset.node === selectedId)
    })
    element.querySelectorAll('path[id^="L_"], path[id^="L-"]').forEach(path => {
      const ids = path.id.match(/N\d+/g) || []
      path.classList.toggle('flow-hl-edge', ids.length >= 2 && set.has(ids[0]) && set.has(ids[1]))
    })
  }, [svg, highlight, selectedId])

  // Fit again when the viewport first gets a size (e.g. its tab was hidden while rendering).
  useEffect(() => {
    const element = viewport.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let last = element.clientWidth
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth
      if (!last && width) fit()
      last = width
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [fit])

  // Wheel zoom: always in full screen, with Ctrl/Cmd (or a trackpad pinch) inline.
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = event => {
      if (!full && !event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const box = element.getBoundingClientRect()
      zoomAt(Math.exp(-event.deltaY * 0.0018), event.clientX - box.left, event.clientY - box.top)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [full, zoomAt])

  useEffect(() => {
    if (!full) return
    const onKey = event => { if (event.key === 'Escape') setFull(false) }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    const timer = setTimeout(fit, 30)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); clearTimeout(timer); setTimeout(fit, 30) }
  }, [full, fit])

  function onPointerDown(event) {
    if (event.button !== 0 || event.target.closest?.('.flow-overlay, button, a, input, select, textarea')) return
    drag.current = { x: event.clientX, y: event.clientY, vx: view.current.x, vy: view.current.y, moved: false }
    viewport.current.setPointerCapture(event.pointerId)
  }
  function onPointerMove(event) {
    const d = drag.current
    if (!d) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    view.current = { ...view.current, x: d.vx + dx, y: d.vy + dy }
    apply()
  }
  function onPointerUp(event) {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const id = nodeIdOf(target)
    onSelect?.(id && id !== selectedId ? id : null)
  }
  function onKeyDown(event) {
    const step = 60
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
    if (event.key === '+' || event.key === '=') zoomAt(1.2)
    else if (event.key === '-' || event.key === '_') zoomAt(1 / 1.2)
    else if (event.key === '0') fit()
    else if (event.key === 'Enter' && nodeIdOf(event.target)) onSelect?.(nodeIdOf(event.target))
    else if (moves[event.key]) {
      view.current = { ...view.current, x: view.current.x + moves[event.key][0], y: view.current.y + moves[event.key][1] }
      apply()
    } else return
    event.preventDefault()
  }

  // Self-contained SVG (mermaid embeds its styles) with a solid background.
  function exportSvg() {
    const element = stage.current?.querySelector('svg')
    if (!element) return null
    const clone = element.cloneNode(true)
    clone.classList.remove('flow-focus')
    clone.querySelectorAll('.flow-hl, .flow-selected, .flow-hl-edge').forEach(n => n.classList.remove('flow-hl', 'flow-selected', 'flow-hl-edge'))
    const { w, h } = size.current
    const box = element.viewBox.baseVal
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', w)
    clone.setAttribute('height', h)
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    Object.entries({ x: box.x, y: box.y, width: box.width, height: box.height, fill: light ? THEMES.light.bg : THEMES.dark.bg })
      .forEach(([k, v]) => bg.setAttribute(k, v))
    clone.insertBefore(bg, clone.firstChild)
    return { text: new XMLSerializer().serializeToString(clone), w, h }
  }
  function save(blob, name) {
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: name }).click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function downloadPng() {
    const out = exportSvg()
    if (!out) return
    const image = new Image()
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(out.text)
    await image.decode()
    const header = 64
    const pad = 24
    const width = out.w + pad * 2
    const height = out.h + header + pad
    // Crisp: up to 3x, capped to stay inside browser canvas limits.
    const scale = Math.max(1, Math.min(3, 16000 / width, 16000 / height, Math.sqrt(120e6 / (width * height))))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    const theme = light ? THEMES.light : THEMES.dark
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = theme.text
    ctx.font = `600 18px ${FONT}`
    ctx.fillText(title || graph.title || 'Logical flow', pad, 36)
    ctx.fillStyle = theme.muted
    ctx.font = `12px ${FONT}`
    ctx.fillText(`QuCoRe flow map · ${new Date().toLocaleDateString()}`, pad, 54)
    ctx.drawImage(image, pad, header, out.w, out.h)
    canvas.toBlob(blob => blob && save(blob, `${slug(title || graph.title)}.png`), 'image/png')
  }
  function downloadSvg() {
    const out = exportSvg()
    if (out) save(new Blob([out.text], { type: 'image/svg+xml' }), `${slug(title || graph.title)}.svg`)
  }
  async function copySource() {
    try { await navigator.clipboard.writeText(source); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }

  const tool = (label, Icon, action, extra = {}) => <button type="button" className="btn-small" title={label} aria-label={label} onClick={action} {...extra}><Icon size={15} /></button>

  return <div className={full ? 'flow-full' : 'flow-frame'}>
    <div className="flow-toolbar">
      <div className="flex items-center gap-0.5">
        {tool('Zoom out (-)', ZoomOut, () => zoomAt(1 / 1.25))}
        <span className="text-[11px] text-muted w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        {tool('Zoom in (+)', ZoomIn, () => zoomAt(1.25))}
        {tool('Fit to view (0)', Scan, fit)}
        <button type="button" className="btn-small" title="Actual size" onClick={() => { view.current = { ...view.current, k: 1 }; apply() }}>1:1</button>
      </div>
      <span className="flow-sep" />
      <div className="flex items-center gap-1">
        <button type="button" className={`flow-toggle ${direction === 'TB' ? 'flow-toggle-on' : ''}`} onClick={() => setDirection('TB')} title="Top to bottom"><ArrowDownUp size={13} />Vertical</button>
        <button type="button" className={`flow-toggle ${direction === 'LR' ? 'flow-toggle-on' : ''}`} onClick={() => setDirection('LR')} title="Left to right"><ArrowLeftRight size={13} />Horizontal</button>
        <button type="button" className={`flow-toggle ${showFiles ? 'flow-toggle-on' : ''}`} onClick={() => setShowFiles(!showFiles)} aria-pressed={showFiles} title="Show the file under each step"><FileCode2 size={13} />File names</button>
        <select className="flow-select" value={layout} onChange={e => setLayout(e.target.value)} aria-label="Layout engine" title="Layout engine">
          <option value="dagre">Standard layout</option>
          <option value="elk">Orthogonal layout</option>
        </select>
      </div>
      <div className="flex items-center gap-1 ml-auto">
        <button type="button" className="btn-small" onClick={copySource} title="Copy the Mermaid source">{copied ? <Check size={14} /> : <ClipboardCopy size={14} />}Mermaid</button>
        <button type="button" className="btn-small" onClick={downloadSvg} disabled={!svg} title="Download SVG">SVG</button>
        <button type="button" className="btn-primary py-1.5! px-3! text-xs!" onClick={downloadPng} disabled={!svg}><ImageDown size={14} />PNG</button>
        {tool(full ? 'Exit full screen (Esc)' : 'Full screen', full ? Minimize2 : Maximize, () => setFull(!full))}
      </div>
    </div>
    <div ref={viewport} className="flow-viewport" tabIndex={0} aria-label="Flow diagram. Drag to pan, plus and minus to zoom, 0 to fit."
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null }} onKeyDown={onKeyDown}>
      <div ref={stage} className="flow-stage" dangerouslySetInnerHTML={{ __html: svg }} />
      {busy && <div className="flow-status"><LoaderCircle size={16} className="animate-spin" />Laying out the diagram…</div>}
      {error && <div className="flow-status text-removed">{error}</div>}
      {overlay}
      <p className="flow-hint">{full ? 'Scroll to zoom' : 'Ctrl + scroll to zoom'} · drag to pan · click a box for details</p>
    </div>
  </div>
}
