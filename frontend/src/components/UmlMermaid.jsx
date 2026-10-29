import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ClipboardCopy, ImageDown, LoaderCircle, Scan, ZoomIn, ZoomOut } from 'lucide-react'
import { FONT, mermaidConfig, THEMES } from '../flowMermaid.js'

// Mermaid is loaded the first time a diagram is shown. mermaid.render is not re-entrant, so renders are queued.
let loader
let queue = Promise.resolve()
let counter = 0
const load = () => (loader ??= import('mermaid').then(m => m.default))
function renderMermaid(config, source) {
  const job = queue.then(async () => {
    const mermaid = await load()
    mermaid.initialize(config)
    const id = `qumlm${++counter}`
    try { return (await mermaid.render(id, source)).svg } finally { document.getElementById(id)?.remove(); document.getElementById('d' + id)?.remove() }
  })
  queue = job.catch(() => {})
  return job
}
const slug = value => String(value || 'uml').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'uml'

export default function UmlMermaid({ source, light, title }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [copied, setCopied] = useState(false)
  const viewport = useRef(null)
  const stage = useRef(null)
  const view = useRef({ x: 0, y: 0, k: 1 })
  const size = useRef({ w: 0, h: 0 })
  const drag = useRef(null)

  useEffect(() => {
    let live = true
    setBusy(true); setError('')
    renderMermaid({ ...mermaidConfig(light), flowchart: { htmlLabels: false } }, source)
      .then(result => live && setSvg(result)).catch(err => live && setError(err?.message || 'The diagram could not be drawn.')).finally(() => live && setBusy(false))
    return () => { live = false }
  }, [source, light])

  const apply = useCallback(() => {
    const { x, y, k } = view.current
    if (stage.current) stage.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    setZoom(k)
  }, [])
  const fit = useCallback(() => {
    const box = viewport.current?.getBoundingClientRect()
    const { w, h } = size.current
    if (!box || !w || !h) return
    const k = Math.min(Math.max(Math.min((box.width - 40) / w, (box.height - 40) / h, 1.3), 0.1), 4)
    view.current = { k, x: (box.width - w * k) / 2, y: Math.max(20, (box.height - h * k) / 2) }
    apply()
  }, [apply])
  const zoomAt = useCallback((factor, cx, cy) => {
    const box = viewport.current?.getBoundingClientRect()
    if (!box) return
    const { x, y, k } = view.current
    const next = Math.min(Math.max(k * factor, 0.1), 4)
    const px = cx ?? box.width / 2
    const py = cy ?? box.height / 2
    view.current = { k: next, x: px - (px - x) * (next / k), y: py - (py - y) * (next / k) }
    apply()
  }, [apply])

  useLayoutEffect(() => {
    const el = stage.current?.querySelector('svg')
    if (!el) return
    const box = el.viewBox?.baseVal
    const w = box?.width || el.getBBox().width
    const h = box?.height || el.getBBox().height
    el.setAttribute('width', w); el.setAttribute('height', h); el.style.maxWidth = 'none'
    size.current = { w, h }
    fit()
  }, [svg]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = viewport.current
    if (!el) return undefined
    const wheel = event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); const b = el.getBoundingClientRect(); zoomAt(Math.exp(-event.deltaY * 0.0018), event.clientX - b.left, event.clientY - b.top) }
    el.addEventListener('wheel', wheel, { passive: false })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null
    observer?.observe(el)
    return () => { el.removeEventListener('wheel', wheel); observer?.disconnect() }
  }, [zoomAt, fit])

  function exportSvg() {
    const el = stage.current?.querySelector('svg')
    if (!el) return null
    const clone = el.cloneNode(true)
    const { w, h } = size.current
    const box = el.viewBox.baseVal
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width', w); clone.setAttribute('height', h)
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    Object.entries({ x: box.x, y: box.y, width: box.width, height: box.height, fill: (light ? THEMES.light : THEMES.dark).bg }).forEach(([k, v]) => bg.setAttribute(k, v))
    clone.insertBefore(bg, clone.firstChild)
    return { text: new XMLSerializer().serializeToString(clone), w, h }
  }
  const save = (blob, name) => { const url = URL.createObjectURL(blob); Object.assign(document.createElement('a'), { href: url, download: name }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
  async function png() {
    const out = exportSvg()
    if (!out) return
    const image = new Image()
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(out.text)
    await image.decode()
    const pad = 24, head = 60
    const width = out.w + pad * 2, height = out.h + head + pad
    const scale = Math.max(1, Math.min(3, 16000 / width, 16000 / height))
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(width * scale), height: Math.round(height * scale) })
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    const theme = light ? THEMES.light : THEMES.dark
    ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = theme.text; ctx.font = `600 18px ${FONT}`; ctx.fillText(title || 'UML diagram', pad, 34)
    ctx.fillStyle = theme.muted; ctx.font = `12px ${FONT}`; ctx.fillText(`QuCoRe UML · ${new Date().toLocaleDateString()}`, pad, 52)
    ctx.drawImage(image, pad, head, out.w, out.h)
    canvas.toBlob(blob => blob && save(blob, `${slug(title)}.png`), 'image/png')
  }
  const tool = (name, Icon, action) => <button type="button" className="btn-small" title={name} aria-label={name} onClick={action}><Icon size={15} /></button>
  const pointerDown = e => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y }; viewport.current.setPointerCapture(e.pointerId) }
  const pointerMove = e => { const d = drag.current; if (!d) return; view.current = { ...view.current, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }; apply() }

  return <div className="flow-frame">
    <div className="flow-toolbar">
      <div className="flex items-center gap-0.5">{tool('Zoom out', ZoomOut, () => zoomAt(1 / 1.25))}
        <span className="text-[11px] text-muted w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>{tool('Zoom in', ZoomIn, () => zoomAt(1.25))}{tool('Fit to view', Scan, fit)}</div>
      <div className="flex items-center gap-1 ml-auto">
        <button type="button" className="btn-small" onClick={async () => { try { await navigator.clipboard.writeText(source); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ } }}>
          {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}Mermaid</button>
        <button type="button" className="btn-small" onClick={() => { const o = exportSvg(); if (o) save(new Blob([o.text], { type: 'image/svg+xml' }), `${slug(title)}.svg`) }} disabled={!svg}>SVG</button>
        <button type="button" className="btn-primary !py-1.5 !px-3 !text-xs" onClick={png} disabled={!svg}><ImageDown size={14} />PNG</button>
      </div>
    </div>
    <div ref={viewport} className="flow-viewport" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <div ref={stage} className="flow-stage" dangerouslySetInnerHTML={{ __html: svg }} />
      {busy && <div className="flow-status"><LoaderCircle size={16} className="animate-spin" />Drawing the diagram…</div>}
      {error && <div className="flow-status text-removed px-6 text-center">{error}</div>}
      <p className="flow-hint">Ctrl + scroll to zoom · drag to pan</p>
    </div>
  </div>
}
