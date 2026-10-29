import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, Check, Copy, FileCode2, ListTree, LoaderCircle, X } from 'lucide-react'
import { api } from '../api.js'

const PAD = 3
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end

// Pop-up for one referenced file: highlighted ranges (cited by the answer and/or sent as
// context), the symbols (functions, classes, methods) they touch, and the file outline.
export default function QACodeModal({ workspaceId, target, onClose }) {
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const [whole, setWhole] = useState(false)
  const [focus, setFocus] = useState(null)
  const [copied, setCopied] = useState(false)
  const body = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    setFile(null)
    setError('')
    setFocus(null)
    if (!workspaceId) { setError('Open the codebase folder to view this code.'); return undefined }
    api.qaSnippet(workspaceId, target.path, controller.signal).then(setFile).catch(err => {
      if (err.name !== 'AbortError') setError(err.message)
    })
    return () => controller.abort()
  }, [workspaceId, target.path])

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow }
  }, [onClose])

  const lines = useMemo(() => (file ? file.content.split(/\r\n|\n|\r/) : []), [file])
  const total = lines.length
  const clamp = range => ({ ...range, start: Math.max(1, Math.min(total || 1, range.start)), end: Math.max(1, Math.min(total || 1, range.end)) })
  const cited = useMemo(() => (target.cited || []).filter(r => r.start).map(r => ({ ...r, cited: true })), [target])
  const context = useMemo(() => (target.context || []).filter(r => r.start), [target])
  const marks = useMemo(() => (total ? [...cited, ...context].map(clamp) : []), [cited, context, total]) // eslint-disable-line react-hooks/exhaustive-deps
  const symbols = useMemo(() => (file?.outline || []).filter(item => marks.some(m => overlaps(m, item))), [file, marks])
  const showWhole = whole || !marks.length || focus

  // Excerpt view: every marked range with a few lines of context, "…" between excerpts.
  const excerpts = useMemo(() => {
    if (showWhole || !total) return [{ start: 1, end: total }]
    const ranges = marks.map(r => ({ start: Math.max(1, r.start - PAD), end: Math.min(total, r.end + PAD) }))
      .sort((a, b) => a.start - b.start)
    const merged = []
    for (const r of ranges) {
      const last = merged[merged.length - 1]
      if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end)
      else merged.push({ ...r })
    }
    return merged
  }, [showWhole, marks, total])

  const kindOf = number => {
    if (cited.some(r => number >= r.start && number <= r.end)) return 'qa-line-cited'
    if (context.some(r => number >= r.start && number <= r.end)) return 'qa-line-context'
    if (focus && number >= focus.start && number <= focus.end) return 'qa-line-focus'
    return ''
  }

  useEffect(() => {
    if (!file || !body.current) return
    const first = focus?.start || cited[0]?.start || context[0]?.start
    if (!first) return
    const row = body.current.querySelector(`[data-line="${first}"]`)
    if (row) row.scrollIntoView({ block: 'center' })
  }, [file, focus, whole]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedText = () => excerpts.map(r => lines.slice(r.start - 1, r.end).join('\n')).join('\n…\n')

  return createPortal(<div className="qa-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="qa-modal" role="dialog" aria-modal="true" aria-label={`Code: ${target.path}`}>
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
        <div className="min-w-0">
          <p className="eyebrow flex items-center gap-2"><FileCode2 size={12} />Referenced code</p>
          <h3 className="font-mono text-sm font-semibold break-all mt-1">{target.path}</h3>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {cited.map((r, i) => <span key={`c${i}`} className="qa-range qa-range-cited">cited L{r.start}{r.end !== r.start ? `-${r.end}` : ''}</span>)}
            {context.map((r, i) => <span key={`x${i}`} className="qa-range">{r.label ? `${r.label} · ` : ''}L{r.start}-{r.end}</span>)}
            {total > 0 && <span className="text-[11px] text-muted self-center">{total.toLocaleString()} lines{file?.language ? ` · ${file.language}` : ''}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {marks.length > 0 && <button type="button" className="btn-small" onClick={() => { setFocus(null); setWhole(!whole) }}>
            {showWhole && !focus ? 'Show excerpts' : 'Whole file'}</button>}
          <button type="button" className="btn-small" disabled={!file} onClick={async () => {
            try { await navigator.clipboard.writeText(selectedText()); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
          }}>{copied ? <Check size={13} /> : <Copy size={13} />}Copy</button>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
      </div>
      <div className="qa-modal-body">
        <aside className="qa-modal-outline">
          {symbols.length > 0 && <>
            <p className="eyebrow flex items-center gap-1.5 mb-2"><Braces size={11} />In these lines</p>
            {symbols.map(item => <button key={`s${item.name}${item.start}`} type="button" className="qa-outline-item qa-outline-hit"
              onClick={() => setFocus({ start: item.start, end: item.end })}>
              <span className="truncate">{item.name}</span><span className="text-muted">{item.kind} · L{item.start}</span>
            </button>)}
          </>}
          <p className="eyebrow flex items-center gap-1.5 mb-2 mt-4"><ListTree size={11} />Outline</p>
          {(file?.outline || []).map(item => <button key={`o${item.name}${item.start}`} type="button" className="qa-outline-item"
            style={{ paddingLeft: 8 + Math.min(item.depth, 3) * 10 }} onClick={() => setFocus({ start: item.start, end: item.end })}>
            <span className="truncate">{item.name}</span><span className="text-muted">L{item.start}-{item.end}</span>
          </button>)}
          {file && !file.outline?.length && <p className="text-[11px] text-muted">No functions or classes detected.</p>}
        </aside>
        <div ref={body} className="qa-modal-code">
          {!file && !error && <div className="flex items-center gap-2 text-muted text-sm p-6"><LoaderCircle size={16} className="animate-spin" />Loading code…</div>}
          {error && <p className="error-box m-5">{error}</p>}
          {file && excerpts.map((range, index) => <div key={`${range.start}-${index}`}>
            {index > 0 && <div className="qa-gap">⋯ lines {excerpts[index - 1].end + 1}–{range.start - 1} ⋯</div>}
            {lines.slice(range.start - 1, range.end).map((line, offset) => {
              const number = range.start + offset
              return <div key={number} data-line={number} className={`qa-line ${kindOf(number)}`}>
                <span className="qa-line-no">{number}</span><span className="qa-line-text">{line || ' '}</span>
              </div>
            })}
          </div>)}
        </div>
      </div>
    </div>
  </div>, document.body)
}
