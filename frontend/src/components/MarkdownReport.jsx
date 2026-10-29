import { Children, isValidElement, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ClipboardCopy, Copy, Download, Maximize2, Minimize2, Search, X } from 'lucide-react'

// Ratings are recognised in any table the prompt asks for, so severity and
// verdict columns are colour-coded and sortable whatever their header is called.
const RATING_GROUP = {
  critical: 'critical', blocker: 'critical', high: 'high', major: 'high', medium: 'medium', moderate: 'medium',
  low: 'low', minor: 'low', info: 'info', informational: 'info', note: 'info',
  pass: 'pass', passed: 'pass', partial: 'partial', mixed: 'partial', fail: 'fail', failed: 'fail',
}
const RATING_RANK = { critical: 0, fail: 0, high: 1, medium: 2, partial: 2, low: 3, info: 4, pass: 5 }
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu

export function ratingOf(text) {
  const plain = String(text || '').replace(EMOJI, '').replace(/[*_`.:()[\]–—-]/g, ' ').trim().toLowerCase()
  if (!plain) return null
  if (RATING_GROUP[plain]) return RATING_GROUP[plain]
  const words = plain.split(/\s+/)
  return words.length <= 2 && RATING_GROUP[words[0]] && words[0] !== 'note' ? RATING_GROUP[words[0]] : null
}

export function reactText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactText).join('')
  if (isValidElement(node)) return reactText(node.props.children)
  return ''
}

const elements = children => Children.toArray(children).filter(isValidElement)
const numeric = text => {
  const cleaned = text.replace(/[,%$\s]/g, '').replace(/^L/i, '')
  return cleaned !== '' && /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null
}
const csvCell = text => /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text

function RatingCell({ node, children, ...props }) {
  const rating = ratingOf(reactText(children))
  return <td {...props}>{rating ? <span className={`rating rating-${rating}`}>{children}</span> : children}</td>
}

function InteractiveTable({ children }) {
  const [sort, setSort] = useState({ col: -1, dir: 1 })
  const [query, setQuery] = useState('')
  const [rating, setRating] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const { header, rows, ratingColumn } = useMemo(() => {
    const sections = elements(children)
    const head = sections.find(el => el.type === 'thead')
    const body = sections.find(el => el.type === 'tbody')
    const headerCells = head ? elements(elements(head.props.children)[0]?.props.children) : []
    const rows = (body ? elements(body.props.children) : []).map((tr, index) => {
      const cells = elements(tr.props.children)
      return { index, cells, texts: cells.map(cell => reactText(cell.props.children).trim()) }
    })
    // A column counts as a rating column when most of its filled cells are ratings.
    let ratingColumn = -1
    headerCells.forEach((_, col) => {
      const filled = rows.map(r => r.texts[col]).filter(Boolean)
      const hits = filled.filter(text => ratingOf(text)).length
      if (ratingColumn < 0 && filled.length && hits / filled.length >= 0.6) ratingColumn = col
    })
    return { header: headerCells, rows, ratingColumn }
  }, [children])

  const ratingCounts = useMemo(() => {
    const counts = {}
    if (ratingColumn >= 0) rows.forEach(r => { const g = ratingOf(r.texts[ratingColumn]); if (g) counts[g] = (counts[g] || 0) + 1 })
    return counts
  }, [rows, ratingColumn])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    let out = rows.filter(r => (!needle || r.texts.some(t => t.toLowerCase().includes(needle)))
      && (!rating || ratingOf(r.texts[ratingColumn]) === rating))
    if (sort.col >= 0) {
      const col = sort.col
      const values = out.map(r => r.texts[col] || '')
      const allNumeric = values.filter(Boolean).every(v => numeric(v) !== null)
      out = [...out].sort((a, b) => {
        const x = a.texts[col] || '', y = b.texts[col] || ''
        let result
        const rx = ratingOf(x), ry = ratingOf(y)
        if (rx && ry) result = (RATING_RANK[rx] ?? 9) - (RATING_RANK[ry] ?? 9)
        else if (allNumeric) result = (numeric(x) ?? 0) - (numeric(y) ?? 0)
        else result = x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
        return result * sort.dir || a.index - b.index
      })
    }
    return out
  }, [rows, query, rating, sort, ratingColumn])

  if (!header.length) return <div className="overflow-x-auto my-4"><table>{children}</table></div>

  const headerTexts = header.map(cell => reactText(cell.props.children).trim())
  const csv = () => [headerTexts, ...visible.map(r => r.texts)].map(row => row.map(csvCell).join(',')).join('\n')
  const toggleSort = col => setSort(current => current.col === col ? (current.dir === 1 ? { col, dir: -1 } : { col: -1, dir: 1 }) : { col, dir: 1 })
  async function copy() {
    try { await navigator.clipboard.writeText(csv()); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([csv()], { type: 'text/csv;charset=utf-8' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${(headerTexts[0] || 'table').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv` })
    link.click(); URL.revokeObjectURL(url)
  }
  const filtered = visible.length !== rows.length

  const toolbar = popout => <div className="qtable-toolbar">
    <span className="text-[11px] text-muted whitespace-nowrap">{filtered ? `${visible.length} of ${rows.length}` : rows.length} row{rows.length === 1 ? '' : 's'}</span>
    {Object.keys(ratingCounts).length > 0 && <div className="flex flex-wrap gap-1.5">
      {Object.entries(ratingCounts).sort((a, b) => (RATING_RANK[a[0]] ?? 9) - (RATING_RANK[b[0]] ?? 9)).map(([group, count]) =>
        <button key={group} onClick={() => setRating(rating === group ? '' : group)} aria-pressed={rating === group}
          className={`rating rating-${group} rating-chip ${rating === group ? 'rating-chip-on' : ''}`}>{group} {count}</button>)}
    </div>}
    <div className="flex items-center gap-1 ml-auto">
      {(rows.length > 4 || popout) && <label className="qtable-search"><Search size={12} className="text-muted" />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter rows" aria-label="Filter table rows" />
        {query && <button onClick={() => setQuery('')} aria-label="Clear filter"><X size={12} /></button>}</label>}
      <button className="btn-small" onClick={copy} title="Copy as CSV">{copied ? <Check size={13} /> : <ClipboardCopy size={13} />}</button>
      <button className="btn-small" onClick={download} title="Download CSV"><Download size={13} /></button>
      {!popout && <button className="btn-small" onClick={() => setExpanded(true)} title="Open in a larger view" aria-label="Open table in a larger view"><Maximize2 size={13} /></button>}
    </div>
  </div>

  const table = <>
    <table>
      <thead><tr>{header.map((cell, col) => {
        const active = sort.col === col
        const Icon = active ? (sort.dir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown
        return <th key={col} style={cell.props.style} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
          <button className="qtable-sort" onClick={() => toggleSort(col)}>{cell.props.children}<Icon size={11} className={active ? 'text-sky-400' : 'opacity-40'} /></button>
        </th>
      })}</tr></thead>
      <tbody>{visible.map(row => <tr key={row.index}>{row.cells}</tr>)}</tbody>
    </table>
    {!visible.length && <p className="text-xs text-muted p-4">No rows match this filter.</p>}
  </>

  return <>
    <div className="qtable">
      {toolbar(false)}
      <div className="qtable-scroll">{table}</div>
    </div>
    {expanded && <TableModal title={headerTexts.slice(0, 3).join(' · ') || 'Table'} onClose={() => setExpanded(false)}>
      <div className="qtable qtable-popout">
        {toolbar(true)}
        <div className="qtable-scroll">{table}</div>
      </div>
    </TableModal>}
  </>
}

// The enlarged table opens in its own window-sized dialog (not inside the report card).
function TableModal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose() }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey) }
  }, [onClose])
  return createPortal(<div className="qmodal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="qmodal report-markdown" role="dialog" aria-modal="true" aria-label={title}>
      <div className="qmodal-head"><span className="text-sm font-semibold truncate">{title}</span>
        <button className="btn-icon" onClick={onClose} title="Close (Esc)" aria-label="Close enlarged table"><X size={18} /></button></div>
      {children}
    </div>
  </div>, document.body)
}

function CodeBlock({ children, ...props }) {
  const [copied, setCopied] = useState(false)
  const code = reactText(children)
  const language = (elements(children)[0]?.props.className || '').replace('language-', '')
  return <div className="qcode">
    <div className="qcode-bar"><span>{language || 'code'}</span>
      <button className="btn-small" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ } }}>
        {copied ? <><Check size={12} />Copied</> : <><Copy size={12} />Copy</>}</button></div>
    <pre {...props}>{children}</pre>
  </div>
}

// No raw-HTML plugin, script execution, or remote image fetches. Custom table
// headers/columns come directly from the model's prompt-directed Markdown.
export default function MarkdownReport({ text }) {
  return <div className="report-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    table: ({ node, children }) => <InteractiveTable>{children}</InteractiveTable>,
    td: RatingCell,
    pre: ({ node, children, ...props }) => <CodeBlock {...props}>{children}</CodeBlock>,
    a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
  }}>{text || ''}</ReactMarkdown></div>
}
