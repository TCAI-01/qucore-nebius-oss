import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Check, ClipboardCopy, Code2, FileJson, ListTree } from 'lucide-react'
import { downloadUrl } from '../api.js'
import MarkdownReport, { ratingOf } from './MarkdownReport.jsx'
import UsageMetrics from './UsageMetrics.jsx'
import { useChanges } from './ChangesContext.jsx'

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

// Severity counts from whatever tables the prompt produced (cells that are just a rating).
function severityCounts(markdown) {
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0]))
  let fence = false
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) { fence = !fence; continue }
    if (fence || !line.startsWith('|') || /^\|?[\s:|-]+\|?$/.test(line)) continue
    for (const cell of line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/)) {
      const rating = ratingOf(cell)
      if (rating in counts) counts[rating] += 1
    }
  }
  return counts
}

export default function CustomReport({ review }) {
  const report = review.report
  const body = useRef(null)
  const [headings, setHeadings] = useState([])
  const [copied, setCopied] = useState(false)
  const { openQuCoder } = useChanges()
  const counts = useMemo(() => severityCounts(report.report_markdown), [report.report_markdown])
  const total = SEVERITIES.reduce((sum, s) => sum + counts[s], 0)

  // Build the section index from the rendered headings (no ids needed).
  useEffect(() => {
    const nodes = body.current ? [...body.current.querySelectorAll('h1, h2, h3')] : []
    setHeadings(nodes.map((node, i) => ({ i, text: node.textContent, level: node.tagName, node })))
  }, [report.report_markdown])

  async function copyMarkdown() {
    try { await navigator.clipboard.writeText(report.report_markdown); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }

  return <div className="space-y-5">
    <section className="card p-6">
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div><p className="eyebrow text-added">Review complete</p>
          <h2 className="text-2xl font-semibold mt-2">{report.workspace_name || 'Code review'}</h2>
          <p className="text-muted text-xs mt-2">{new Date(report.created_at).toLocaleString()} · {report.deployment}{report.provider_label ? ` · ${report.provider_label}` : ''} · {report.prompt?.name}</p></div>
        <div className="flex flex-wrap gap-2">
          <a className="btn-primary" href={downloadUrl(review.id, 'pdf')}><ArrowDownToLine size={15} />PDF report</a>
          <a className="btn" href={downloadUrl(review.id, 'json')}><FileJson size={15} />JSON</a>
          <button className="btn" title="Turn this review into code changes you can review, save and apply" onClick={() => openQuCoder({
            files: (report.files || []).map(f => f.path),
            prompt: `Apply the fixes recommended in this code review to the reference files. Make the smallest safe changes, keep behaviour the same, and list what you changed.\n\n--- Review ---\n${String(report.report_markdown || '').slice(0, 9000)}` })}><Code2 size={15} />Fix with QuCoder</button>
          <button className="btn" onClick={copyMarkdown}>{copied ? <Check size={15} /> : <ClipboardCopy size={15} />}{copied ? 'Copied' : 'Markdown'}</button>
        </div>
      </div>
      {total > 0 && <div className="mt-5">
        <div className="severity-bar" aria-label="Ratings found in the report">
          {SEVERITIES.filter(s => counts[s]).map(s => <span key={s} className={`severity-seg sev-${s}`} style={{ flexGrow: counts[s] }} title={`${s}: ${counts[s]}`} />)}
        </div>
        <div className="flex flex-wrap gap-2 mt-3">{SEVERITIES.filter(s => counts[s]).map(s => <span key={s} className={`rating rating-${s}`}>{s} {counts[s]}</span>)}</div>
      </div>}
    </section>
    <UsageMetrics metrics={review.metrics || report.metrics} />
    {report.summary_note && <p className="error-box">{report.summary_note}</p>}
    <div className={headings.length > 2 ? 'grid xl:grid-cols-[1fr_220px] gap-5 items-start' : ''}>
      <section className="card p-6 min-w-0" ref={body}><MarkdownReport text={report.report_markdown} /></section>
      {headings.length > 2 && <nav className="card p-4 hidden xl:block sticky top-4" aria-label="Report sections">
        <p className="eyebrow flex items-center gap-2 mb-3"><ListTree size={13} />Sections</p>
        <ul className="space-y-1">{headings.map(h => <li key={h.i}>
          <button onClick={() => h.node.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className={`toc-link ${h.level === 'H3' ? 'pl-4 text-[11px]' : ''}`}>{h.text}</button></li>)}</ul>
      </nav>}
    </div>
    {report.batch_reports?.length > 1 && <section className="card p-6"><h3 className="section-title mb-4">Original batch reports</h3><p className="text-xs text-muted mb-4">Retained in full so a combined report cannot hide batch-level details.</p>{report.batch_reports.map(batch => <details key={batch.number} className="border-t border-line py-4"><summary className="cursor-pointer text-sm font-medium">Batch {batch.number} · {batch.files.length} files · {batch.lines.toLocaleString()} lines</summary><p className="text-xs font-mono text-muted my-4 break-all">{batch.files.join(', ')}</p><MarkdownReport text={batch.report_markdown} /></details>)}</section>}
    <details className="card p-6"><summary className="font-semibold cursor-pointer">Scope and files reviewed</summary><p className="text-sm text-muted mt-4">{report.review_limits}</p><div className="overflow-x-auto mt-4"><table className="report-table"><thead><tr><th>File</th><th>Lines</th><th>SHA-256</th></tr></thead><tbody>{report.files.map(file => <tr key={file.path}><td className="break-all">{file.path}</td><td>{file.lines}</td><td className="font-mono text-[10px] break-all">{file.sha256}</td></tr>)}</tbody></table></div></details>
  </div>
}
