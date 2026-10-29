import { useMemo } from 'react'
import { Code2, GitCommitHorizontal, LoaderCircle } from 'lucide-react'
import { extractSonarChanges } from '../changeParse.js'
import { useChanges } from './ChangesContext.jsx'

// The "Current / Fixed" code pairs of a SonarCute report, as changes you can review, save, replace and revert.
export default function SonarChanges({ item }) {
  const { openDraft, openQuCoder, busy } = useChanges()
  const changes = useMemo(() => extractSonarChanges(item.markdown), [item.markdown])
  if (!changes.length) return null
  const name = item.path.split('/').pop()
  const snippet = c => ({ before_code: c.before_code, after_code: c.after_code, line_start: c.line_start, line_end: c.line_end })
  return <section className="sd-changes" aria-label="Proposed code changes">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div><p className="eyebrow flex items-center gap-2"><GitCommitHorizontal size={13} />Proposed code changes · {changes.length}</p>
        <p className="text-[11px] text-muted mt-1">See before and after, edit it, then save, download, replace the file or revert.</p></div>
      <div className="flex gap-2">
        <button type="button" className="btn !py-1.5 !text-xs" onClick={() => openQuCoder({ files: [item.path], prompt: `Apply the SonarQube fixes to ${item.path}. Fix these issues without changing behaviour:\n${changes.map((c, i) => `${i + 1}. ${c.title}`).join('\n')}` })}>
          <Code2 size={14} />Fix with QuCoder</button>
        <button type="button" className="btn-primary !py-1.5 !text-xs" disabled={busy} onClick={() => openDraft({ path: item.path, title: `SonarQube: ${changes.length} fix${changes.length === 1 ? '' : 'es'} in ${name}`, source: 'sonarcute', edits: changes.map(snippet) })}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <GitCommitHorizontal size={14} />}Review and apply all {changes.length}</button>
      </div>
    </div>
    <ul className="space-y-2">{changes.map((c, i) => <li key={i} className="sd-change-row">
      <div className="min-w-0 flex-1"><p className="text-sm font-medium truncate">{c.title || `Fix ${i + 1}`}</p>
        <p className="text-[11px] text-muted mt-0.5">{c.line_start ? `Lines ${c.line_start}${c.line_end > c.line_start ? `-${c.line_end}` : ''} · ` : ''}{c.before_code.split('\n').length} line(s) become {c.after_code.split('\n').length}</p></div>
      <button type="button" className="btn-small shrink-0" disabled={busy} onClick={() => openDraft({ path: item.path, title: `SonarQube: ${c.title || `fix ${i + 1}`}`, source: 'sonarcute', edits: [snippet(c)] })}>Review and apply</button>
    </li>)}</ul>
  </section>
}
