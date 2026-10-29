import { useState } from 'react'
import { AlertTriangle, ArrowDownToLine, CheckCircle2, FileCode2, FileJson, FileText, ShieldCheck } from 'lucide-react'
import { downloadUrl } from '../api.js'
import CustomReport from './CustomReport.jsx'
import UsageMetrics from './UsageMetrics.jsx'
import BrandLoader from './BrandLoader.jsx'

export const severityClass = { critical: 'text-rose-400 bg-rose-400/10 border-rose-400/30', high: 'text-orange-400 bg-orange-400/10 border-orange-400/30', medium: 'text-amber-400 bg-amber-400/10 border-amber-400/30', low: 'text-sky-400 bg-sky-400/10 border-sky-400/30', info: 'text-muted bg-elevated border-line' }

function LegacyReportView({ review }) {
  const [filter, setFilter] = useState('all')
  if (!review) return <div className="card min-h-[420px] flex flex-col items-center justify-center text-center px-8">
    <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5 mb-5"><FileText size={34} className="text-sky-400" /></div>
    <h2 className="text-xl font-semibold">Your next review starts here</h2><p className="text-muted max-w-md text-sm mt-3 leading-relaxed">Open a local codebase, select the files, and choose a saved prompt. QuCoRe turns your review criteria into a structured report.</p>
    <div className="mt-7 flex flex-wrap justify-center gap-3"><span className="pill">One prompt per run</span><span className="pill">Full selected source</span><span className="pill">PDF + JSON</span></div>
  </div>
  if (review.status === 'queued' || review.status === 'running') return <div role="status" className="card p-12 flex flex-col items-center justify-center min-h-[400px] text-center">
    <BrandLoader className="brand-loader-inline mb-6" /><h2 className="text-xl font-semibold">{review.stage || 'Preparing review'}</h2><p className="text-muted text-sm mt-3 max-w-md">The selected prompt and source files are captured for this run. The finished report will appear here and be saved automatically.</p><span className="pill mt-6">Run {review.id.slice(0, 12)}</span>
  </div>
  if (review.status === 'cancelled') return <div role="status" className="card p-8"><h2 className="text-xl font-semibold">Review stopped</h2><p className="text-sm text-muted mt-3">{review.error}</p></div>
  if (review.status === 'failed') return <div role="alert" className="card border-removed/30 p-8"><AlertTriangle className="text-removed mb-4" /><h2 className="text-xl font-semibold">Review could not be completed</h2><p className="text-sm text-muted mt-3">{review.error}</p><p className="text-sm text-muted mt-3">Update the selection or configuration, then start a new run.</p></div>
  const report = review.report
  if (!report) return <div className="card p-8"><BrandLoader label="Loading report…" /></div>
  const counts = Object.fromEntries(Object.keys(severityClass).map(key => [key, report.findings.filter(f => f.severity === key).length]))
  const findings = report.findings.map((f, i) => ({ ...f, number: i + 1 })).filter(f => filter === 'all' || f.severity === filter)
  return <div className="space-y-5">
    <section className="card p-6">
      <div className="flex flex-wrap gap-4 justify-between items-start"><div><p className="eyebrow text-added">Review complete</p><h2 className="text-2xl font-semibold mt-2">{report.prompt.name}</h2><p className="text-muted text-xs mt-2">{new Date(report.created_at).toLocaleString()} · {report.deployment}</p></div>
        <div className="flex gap-2"><a className="btn-primary" href={downloadUrl(review.id, 'pdf')}><ArrowDownToLine size={15} />PDF report</a><a className="btn" aria-label="Download JSON report" href={downloadUrl(review.id, 'json')}><FileJson size={15} />JSON</a></div></div>
      <div className="grid grid-cols-3 gap-3 mt-6">{[[FileCode2, report.files.length, 'Files reviewed'], [AlertTriangle, report.findings.length, 'Findings'], [ShieldCheck, report.strengths.length, 'Strengths']].map(([Icon, count, label]) => <div className="bg-elevated/60 rounded-lg p-4" key={label}><div className="flex items-center gap-2 text-muted"><Icon size={14} /><span className="text-xs">{label}</span></div><div className="text-2xl font-semibold mt-2">{count}</div></div>)}</div>
      <h3 className="section-title mt-6 mb-2">Executive summary</h3><p className="text-sm leading-7 text-fg/85 whitespace-pre-wrap wrap-break-word">{report.summary}</p>
    </section>
    <section className="card overflow-hidden"><div className="p-5 border-b border-line"><h3 className="section-title">Findings register</h3><div className="flex flex-wrap gap-2 mt-4"><button className={`pill cursor-pointer ${filter === 'all' ? 'ring-1 ring-sky-400' : ''}`} onClick={() => setFilter('all')}>All {report.findings.length}</button>{Object.entries(counts).map(([key, count]) => <button key={key} onClick={() => setFilter(key)} className={`pill cursor-pointer ${severityClass[key]} ${filter === key ? 'ring-1 ring-sky-400' : ''}`}>{key} {count}</button>)}</div></div>
      {findings.length ? <div className="overflow-x-auto"><table className="report-table"><thead><tr><th>Priority</th><th>Finding</th><th>Source</th></tr></thead><tbody>{findings.map(f => <tr key={f.number}><td><span className={`pill ${severityClass[f.severity]}`}>{f.severity}</span></td><td><a href={`#finding-${f.number}`} className="hover:text-sky-400 font-medium">F{String(f.number).padStart(2, '0')} · {f.title}</a><div className="text-xs text-muted mt-1">{f.category}</div></td><td className="font-mono text-xs break-all">{f.file}<div className="text-muted mt-1">L{f.line_start}–{f.line_end}</div></td></tr>)}</tbody></table></div> : <p className="text-sm text-muted p-6">{report.findings.length ? 'No findings at this severity.' : 'No actionable findings identified under this prompt. This does not certify the code as defect-free.'}</p>}
    </section>
    {findings.map(f => <article id={`finding-${f.number}`} key={f.number} className="card p-6 scroll-mt-6"><div className="flex gap-3 items-start"><span className={`pill ${severityClass[f.severity]}`}>{f.severity}</span><h3 className="font-semibold">F{String(f.number).padStart(2, '0')} · {f.title}</h3></div><p className="font-mono text-xs text-muted mt-3 break-all">{f.file}:{f.line_start}–{f.line_end}</p>
      <pre className="code-block mt-4">{f.evidence}</pre><p className={`text-xs mt-2 ${f.evidence_verified ? 'text-muted' : 'text-amber'}`}>{f.evidence_verified ? 'Quote matched the cited source.' : 'Quote not matched — manually verify this evidence.'}</p>
      <div className="grid xl:grid-cols-2 gap-5 mt-5"><div><h4 className="field-label">Impact</h4><p className="report-copy">{f.impact}</p></div><div><h4 className="field-label text-sky-400">Recommendation</h4><p className="report-copy">{f.recommendation}</p></div></div>
    </article>)}
    <section className="card p-6"><h3 className="section-title"><CheckCircle2 size={18} className="text-added" />What is working well</h3><div className="mt-4 space-y-5">{report.strengths.map((item, index) => <div key={index} className="border-l-2 border-added/60 pl-4"><h4 className="font-medium text-sm">{item.title}</h4><p className="font-mono text-xs text-muted my-2 break-all">{item.file}:{item.line_start}–{item.line_end}</p><p className="report-copy">{item.explanation}</p></div>)}{!report.strengths.length && <p className="text-muted text-sm">No specific strengths were reported under this prompt.</p>}</div></section>
    <section className="card p-6"><h3 className="section-title">Recommended next steps</h3><ol className="list-decimal pl-5 mt-4 space-y-3 text-sm">{report.next_steps.map((step, i) => <li key={i} className="pl-1 report-copy">{step}</li>)}</ol>{!report.next_steps.length && <p className="text-muted text-sm mt-3">No additional steps were proposed.</p>}</section>
    <details className="card p-6"><summary className="font-semibold cursor-pointer">Scope and limitations</summary><ul className="list-disc pl-5 mt-4 space-y-2 text-muted text-sm">{report.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul><p className="text-xs text-muted mt-4">Semantic ordering: {report.embeddings.enabled ? 'enabled; all files retained' : 'disabled'} · Conservative input budget: {report.budget.input_token_upper_bound.toLocaleString()} tokens</p><div className="overflow-x-auto mt-4"><table className="report-table"><thead><tr><th>Reviewed file</th><th>Lines</th><th>SHA-256</th></tr></thead><tbody>{report.files.map(file => <tr key={file.path}><td className="break-all">{file.path}</td><td>{file.lines}</td><td className="font-mono text-[10px] break-all">{file.sha256}</td></tr>)}</tbody></table></div></details>
  </div>
}

export default function ReportView({ review }) {
  if (review?.report?.format_version === 2) return <CustomReport review={review} />
  return <>{review?.metrics && <UsageMetrics metrics={review.metrics} />}<LegacyReportView review={review} /></>
}
