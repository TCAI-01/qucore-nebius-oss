import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowDownToLine, Bug, Check, CheckCircle2, CircleDashed, ClipboardCopy, FileJson, FileUp,
  History, KeyRound, LoaderCircle, Pencil, RotateCcw, Square, Trash2, Wrench, XCircle,
} from 'lucide-react'
import TabTitle from './TabTitle.jsx'
import { api, sonarDownloadUrl } from '../api.js'
import useRunStop from '../useRunStop.js'
import FileTree from './FileTree.jsx'
import MarkdownReport, { ratingOf } from './MarkdownReport.jsx'
import WorkspacePicker from './WorkspacePicker.jsx'
import SonarChanges from './SonarChanges.jsx'
import { money } from './UsageMetrics.jsx'

const SEV_ORDER = ['BLOCKER', 'CRITICAL', 'HIGH', 'MAJOR', 'MEDIUM', 'MINOR', 'LOW', 'INFO', 'UNSPECIFIED']
const sevRank = s => { const i = SEV_ORDER.indexOf(s); return i < 0 ? 50 : i }
const sortSev = entries => [...entries].sort((a, b) => sevRank(a[0]) - sevRank(b[0]))
const number = value => Number(value || 0).toLocaleString()
const baseName = path => String(path).split(/[\\/]/).pop()

function Severity({ value, count }) {
  const rating = ratingOf(value) || 'info'
  return <span className={`rating rating-${rating}`}>{String(value).toLowerCase()}{count != null && ` ${count}`}</span>
}

function StatusIcon({ status }) {
  if (status === 'done') return <CheckCircle2 size={15} className="text-added shrink-0" />
  if (status === 'failed') return <XCircle size={15} className="text-removed shrink-0" />
  if (status === 'running') return <LoaderCircle size={15} className="text-sky-400 animate-spin shrink-0" />
  return <CircleDashed size={15} className="text-muted shrink-0" />
}

const summary = job => ({ id: job.id, kind: job.kind, status: job.status, stage: job.stage, created_at: job.created_at,
  title: job.title, counts: job.counts, error: job.error, workspace_name: job.workspace_name })

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsDataURL(file)
  })
}

export default function SonarFixes({ workspace, onWorkspace, settings, onError, onConfigure }) {
  const [upload, setUpload] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [mapping, setMapping] = useState({})
  const [editing, setEditing] = useState(new Set())
  const [workspaceFiles, setWorkspaceFiles] = useState([])
  const [resolving, setResolving] = useState(false)
  const [include, setInclude] = useState(new Set())
  const [severities, setSeverities] = useState(new Set())
  const [types, setTypes] = useState(new Set())
  const [job, setJob] = useState(null)
  const [history, setHistory] = useState([])
  const [runningId, setRunningId] = useState(null)
  const [launching, setLaunching] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [active, setActive] = useState(null)
  const picked = useRef(false)
  const input = useRef(null)
  const runStop = useRunStop(runningId, launching, api.sonarStop, onError)
  const [sourcePath, setSourcePath] = useState(null)
  const [source, setSource] = useState(null)
  const [sourceBusy, setSourceBusy] = useState(false)
  useEffect(() => { setSourcePath(null); setSource(null) }, [workspace?.id])
  useEffect(() => {
    setSource(null)
    if (!workspace || !sourcePath) { setSourceBusy(false); return }
    const controller = new AbortController()
    setSourceBusy(true)
    api.file(workspace.id, sourcePath, controller.signal).then(value => {
      if (!controller.signal.aborted) setSource(value)
    }).catch(err => { if (!controller.signal.aborted) onError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setSourceBusy(false) })
    return () => controller.abort()
  }, [workspace?.id, sourcePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api.sonarJobs().then(items => {
    setHistory(items)
    const pending = items.find(item => ['queued', 'running'].includes(item.status))
    if (pending) setRunningId(pending.id)
  }).catch(() => {}) }, [])

  // Match every report path to a file in the opened folder.
  useEffect(() => {
    if (!upload || !workspace) { setMapping({}); setWorkspaceFiles([]); return }
    let live = true
    setResolving(true)
    api.sonarResolve(upload.id, workspace.id).then(result => {
      if (!live) return
      setMapping(Object.fromEntries(result.files.map(f => [f.sonar_path, f])))
      setWorkspaceFiles(result.workspace_files)
      setInclude(new Set(result.files.filter(f => f.path).map(f => f.sonar_path)))
      setEditing(new Set())
    }).catch(err => live && onError(err.message)).finally(() => live && setResolving(false))
    return () => { live = false }
  }, [upload?.id, workspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the running analysis.
  useEffect(() => {
    if (!runningId) return
    let stopped = false
    let timer
    async function poll() {
      try {
        const next = await api.sonarJob(runningId)
        if (stopped) return
        setJob(current => (!current || current.id === next.id ? next : current))
        setHistory(items => [summary(next), ...items.filter(item => item.id !== next.id)])
        if (!['queued', 'running'].includes(next.status)) { setRunningId(null); return }
      } catch { /* retried */ }
      if (!stopped) timer = setTimeout(poll, 2000)
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [runningId])

  // Follow the file being analysed until the user picks one.
  useEffect(() => {
    if (!job || picked.current) return
    const running = job.items.find(item => item.status === 'running')
    const target = running || (active == null ? job.items.find(i => i.status === 'done') || job.items[0] : null)
    if (target && target.index !== active) setActive(target.index)
  }, [job]) // eslint-disable-line react-hooks/exhaustive-deps

  const fileSet = useMemo(() => new Set(workspaceFiles), [workspaceFiles])
  const filteredCount = file => {
    if (!file.combos?.length) return file.count
    return file.combos.reduce((sum, [sev, kind, n]) =>
      sum + ((!severities.size || severities.has(sev)) && (!types.size || types.has(kind)) ? n : 0), 0)
  }
  const rows = upload?.files || []
  const ready = rows.filter(f => include.has(f.sonar_path) && fileSet.has(mapping[f.sonar_path]?.path) && filteredCount(f) > 0)
  const readyIssues = ready.reduce((sum, f) => sum + filteredCount(f), 0)
  const unmatched = rows.filter(f => mapping[f.sonar_path] && !fileSet.has(mapping[f.sonar_path].path)).length
  const busy = Boolean(runningId) || launching
  useEffect(() => { if (!busy) setRetrying(false) }, [busy])

  async function choose(file) {
    if (!file) return
    if (file.size > 25 * 1024 * 1024) { onError('The report exceeds 25 MiB. Export fewer issues or filter them first.'); return }
    setUploading(true)
    try {
      const result = await api.sonarUpload(file.name, await readBase64(file))
      setUpload(result)
      setSeverities(new Set())
      setTypes(new Set())
      setInclude(new Set(result.files.map(f => f.sonar_path)))
    } catch (err) {
      onError(err.message)
    } finally {
      setUploading(false)
      if (input.current) input.current.value = ''
    }
  }

  function setPath(sonarPath, path) {
    setMapping(current => ({ ...current, [sonarPath]: { ...current[sonarPath], path, status: 'manual' } }))
    if (fileSet.has(path)) setInclude(current => new Set(current).add(sonarPath))
  }
  const toggle = (setter, value) => setter(current => {
    const next = new Set(current)
    next.has(value) ? next.delete(value) : next.add(value)
    return next
  })

  async function run() {
    setRetrying(false)
    runStop.begin()
    setLaunching(true)
    try {
      const started = await api.sonarRun({
        upload_id: upload.id, workspace_id: workspace.id,
        files: ready.map(f => ({ sonar_path: f.sonar_path, path: mapping[f.sonar_path].path })),
        severities: [...severities], types: [...types],
      })
      picked.current = false
      setActive(null)
      setJob(started)
      setHistory(items => [summary(started), ...items])
      setRunningId(started.id)
      await runStop.started(started.id)
    } catch (err) {
      onError(err.message)
    } finally {
      setLaunching(false)
    }
  }
  async function retry() {
    if (!workspace) { onError('Open the codebase folder first; failed files are read from it again.'); return }
    setRetrying(true)
    runStop.begin()
    setLaunching(true)
    try {
      const started = await api.sonarRetry(job.id, workspace.id)
      picked.current = false
      setJob(started)
      setRunningId(started.id)
      await runStop.started(started.id)
    } catch (err) { onError(err.message) } finally { setLaunching(false) }
  }
  async function show(id) {
    try { picked.current = false; setActive(null); setJob(await api.sonarJob(id)) } catch (err) { onError(err.message) }
  }
  async function remove(id) {
    try {
      await api.sonarDelete(id)
      setHistory(items => items.filter(item => item.id !== id))
      if (job?.id === id) setJob(null)
    } catch (err) { onError(err.message) }
  }

  return <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[350px_minmax(0,1fr)] min-h-[calc(100vh-96px)]">
    <aside className="bg-panel border-r border-line flex flex-col min-w-0">
      <WorkspacePicker workspace={workspace} onWorkspace={onWorkspace} onError={onError} label="01 / Codebase"
        suggestion={upload?.suggested_root} suggestionNote="The report's file paths point to this folder:" />
      {workspace && <div className="border-b border-line">
        <div className="max-h-[360px] overflow-auto">
          <FileTree tree={workspace.tree} selected={new Set()} readOnly activePath={sourcePath} onOpen={setSourcePath} />
        </div>
        {sourcePath && <details open className="px-5 pb-4">
          <summary className="font-mono text-[11px] break-all cursor-pointer">{sourcePath}</summary>
          {sourceBusy ? <p className="text-xs text-muted mt-2">Loading source…</p>
            : source && <pre className="code-block mt-2 max-h-64 overflow-auto text-[11px]">{source.content}</pre>}
        </details>}
      </div>}
      <div className="p-5 border-b border-line">
        <p className="eyebrow mb-3">02 / SonarQube report</p>
        <div className={`sonar-drop ${dragging ? 'sonar-drop-on' : ''}`} role="button" tabIndex={0}
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0]) }}>
          {uploading ? <LoaderCircle size={20} className="animate-spin text-sky-400" /> : <FileUp size={20} className="text-sky-400" />}
          <span className="text-xs font-medium">{uploading ? 'Reading report…' : upload ? 'Replace report' : 'Drop or choose a report'}</span>
          <span className="text-[10px] text-muted">.xlsx, .csv or SonarQube API .json</span>
        </div>
        <input ref={input} type="file" className="hidden" accept=".xlsx,.xlsm,.csv,.tsv,.txt,.json" onChange={e => choose(e.target.files?.[0])} />
        {upload && <p className="field-help"><span className="text-fg font-medium break-all">{upload.filename}</span> · {number(upload.issue_count)} issues in {number(upload.file_count)} files</p>}
      </div>
      <div className="p-5 mt-auto">
        <h2 className="eyebrow flex gap-2 items-center mb-4"><History size={13} />Recent analyses</h2>
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {history.map(item => <div key={item.id} className={`group flex items-start gap-1 rounded-lg hover:bg-elevated ${job?.id === item.id ? 'bg-elevated' : ''}`}>
            <button onClick={() => show(item.id)} className="flex-1 min-w-0 text-left p-3">
              <div className="flex gap-2 items-center">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.status === 'completed' ? (item.counts?.failed ? 'bg-amber' : 'bg-added') : ['failed', 'cancelled'].includes(item.status) ? 'bg-removed' : 'bg-amber animate-pulse'}`} />
                <span className="truncate text-xs font-medium">{item.title}</span>
              </div>
              <div className="flex justify-between text-[10px] text-muted mt-1 pl-3.5">
                <span>{new Date(item.created_at).toLocaleDateString()} · {item.counts?.files || 0} files · {item.counts?.issues || 0} issues</span>
                <span>{item.status}</span>
              </div>
            </button>
            {!['queued', 'running'].includes(item.status) && <button className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5 mr-1" title="Delete" aria-label="Delete analysis" onClick={() => remove(item.id)}><Trash2 size={13} /></button>}
          </div>)}
          {!history.length && <p className="text-xs text-muted">Completed analyses are saved here.</p>}
        </div>
      </div>
    </aside>

    <main className="p-5 lg:p-8 xl:p-10 min-w-0 max-w-[1600px] w-full mx-auto">
      <div className="mb-7">
        <p className="eyebrow">Explain it. Fix it.</p>
        <TabTitle icon={Bug} name="QuSonar" tone="violet" />
        <p className="text-sm text-muted mt-2">Each file is sent with all of its SonarQube issues. You get what each issue is, why it occurs here, how to fix it, and the fixed code.</p>
      </div>

      {upload ? <section className="card mb-6 overflow-hidden">
        <div className="p-5 border-b border-line">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="eyebrow mb-2">03 / Files to fix</p>
              <p className="text-xs text-muted">{number(upload.file_count)} unique files from the <span className="font-mono">{upload.file_column}</span> column. Filters apply to every file.</p>
            </div>
            <button className="btn-primary min-w-44" disabled={runStop.stopping || (!busy && (!ready.length || !settings?.configured || resolving))} onClick={busy ? runStop.stop : run}>
              {busy ? <Square size={16} /> : <Wrench size={15} />}
              {runStop.stopping ? 'Stopping…' : busy ? 'Stop' : `Fix ${ready.length} file${ready.length === 1 ? '' : 's'} · ${number(readyIssues)} issues`}
            </button>
          </div>
          {Object.keys(upload.severities).length > 0 && <div className="flex flex-wrap items-center gap-1.5 mt-4">
            <span className="text-[11px] text-muted w-16">Severity</span>
            {sortSev(Object.entries(upload.severities)).map(([sev, count]) => <button key={sev} onClick={() => toggle(setSeverities, sev)} aria-pressed={severities.has(sev)}
              className={`rating rating-${ratingOf(sev) || 'info'} rating-chip ${severities.has(sev) ? 'rating-chip-on' : severities.size ? 'opacity-45' : ''}`}>{sev.toLowerCase()} {count}</button>)}
            {severities.size > 0 && <button className="btn-small" onClick={() => setSeverities(new Set())}>All</button>}
          </div>}
          {Object.keys(upload.types).length > 0 && <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <span className="text-[11px] text-muted w-16">Type</span>
            {Object.entries(upload.types).sort((a, b) => b[1] - a[1]).map(([kind, count]) => <button key={kind} onClick={() => toggle(setTypes, kind)} aria-pressed={types.has(kind)}
              className={`pill cursor-pointer ${types.has(kind) ? 'ring-1 ring-sky-400 text-fg' : types.size ? 'opacity-45' : ''}`}>{kind.toLowerCase().replace(/_/g, ' ')} {count}</button>)}
            {types.size > 0 && <button className="btn-small" onClick={() => setTypes(new Set())}>All</button>}
          </div>}
          {!workspace && <p className="text-xs text-amber mt-4">Open the codebase folder so each report path can be matched to its source file.</p>}
          {workspace && unmatched > 0 && !resolving && <p className="text-xs text-amber mt-4">{unmatched} file{unmatched === 1 ? ' is' : 's are'} not matched to the opened folder. Choose the file, or open the folder the report was made from.</p>}
          {!settings?.configured && <button className="text-xs text-amber mt-3 flex items-center gap-2" onClick={onConfigure}><KeyRound size={13} />Add the endpoint, API key and deployment for {settings?.active?.label || 'the active provider'}.</button>}
        </div>
        <div className="overflow-x-auto max-h-[420px]">
          <table className="report-table sonar-table">
            <thead><tr>
              <th className="w-10"><input type="checkbox" aria-label="Include all matched files" checked={rows.length > 0 && rows.every(f => include.has(f.sonar_path))}
                onChange={e => setInclude(e.target.checked ? new Set(rows.map(f => f.sonar_path)) : new Set())} /></th>
              <th>SonarQube file</th><th>Source file in the opened folder</th><th className="text-right">Issues</th><th>Severity</th>
            </tr></thead>
            <tbody>{rows.map(file => {
              const match = mapping[file.sonar_path]
              const valid = fileSet.has(match?.path)
              const count = filteredCount(file)
              const edit = editing.has(file.sonar_path) || (match && !valid && match.status !== 'ambiguous')
              return <tr key={file.sonar_path} className={count ? '' : 'opacity-45'}>
                <td><input type="checkbox" checked={include.has(file.sonar_path)} onChange={() => toggle(setInclude, file.sonar_path)} aria-label={`Include ${file.sonar_path}`} /></td>
                <td className="min-w-[200px]"><div className="font-medium text-xs">{baseName(file.sonar_path)}</div><div className="font-mono text-[10px] text-muted break-all mt-0.5">{file.sonar_path}</div></td>
                <td className="min-w-[260px]">
                  {!workspace ? <span className="text-[11px] text-muted">Open a folder</span>
                    : resolving || !match ? <LoaderCircle size={14} className="animate-spin text-muted" />
                    : match.status === 'ambiguous' && !editing.has(file.sonar_path) ? <select className="input !py-1.5 text-xs font-mono" value={match.path} onChange={e => setPath(file.sonar_path, e.target.value)}>
                      <option value="">{match.candidates.length} possible files — choose one</option>
                      {match.candidates.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    : edit ? <input className={`input !py-1.5 text-xs font-mono ${match.path && !valid ? '!border-removed' : ''}`} list="sonar-workspace-files" value={match.path}
                      placeholder="Type to find the file" onChange={e => setPath(file.sonar_path, e.target.value)} />
                    : <div className="flex items-center gap-2 min-w-0"><Check size={13} className="text-added shrink-0" /><span className="font-mono text-[11px] break-all">{match.path}</span>
                      <button className="btn-small !p-1 ml-auto shrink-0" title="Choose a different file" aria-label="Choose a different file" onClick={() => toggle(setEditing, file.sonar_path)}><Pencil size={12} /></button></div>}
                </td>
                <td className="text-right tabular-nums text-xs">{count}{count !== file.count && <span className="text-muted"> / {file.count}</span>}</td>
                <td><div className="flex flex-wrap gap-1">{sortSev(Object.entries(file.severities)).map(([sev, n]) => <Severity key={sev} value={sev} count={n} />)}</div></td>
              </tr>
            })}</tbody>
          </table>
          <datalist id="sonar-workspace-files">{workspaceFiles.map(path => <option key={path} value={path} />)}</datalist>
        </div>
      </section> : !job && <section className="card min-h-[340px] flex flex-col items-center justify-center text-center px-8 mb-6">
        <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5 mb-5"><Bug size={34} className="text-sky-400" /></div>
        <h2 className="text-xl font-semibold">Turn SonarQube findings into fixes</h2>
        <p className="text-muted max-w-md text-sm mt-3 leading-relaxed">Upload the exported issues report and open the codebase it was scanned from. Each file is analysed with all of its issues in one request.</p>
        <button className="btn mt-6" onClick={() => input.current?.click()}><FileUp size={15} />Choose a report</button>
      </section>}

      {job && <SonarResult job={job} active={active} onPick={index => { picked.current = true; setActive(index) }} onRetry={retry} running={busy} onStop={runStop.stop} stopping={runStop.stopping} showStop={(!upload || retrying) && busy} />}
    </main>
  </div>
}

function SonarResult({ job, active, onPick, onRetry, running, onStop, stopping, showStop }) {
  const [copied, setCopied] = useState(false)
  const item = job.items.find(i => i.index === active) || job.items[0]
  const remaining = job.items.filter(entry => entry.status !== 'done').length
  const finished = job.counts.done + job.counts.failed
  const pct = job.counts.files ? Math.round((finished / job.counts.files) * 100) : 0
  const report = job.report
  const columns = [report.line_column, report.severity_column, report.type_column, report.rule_column, report.message_column].filter(Boolean)
  const shown = columns.length >= 2 ? columns : report.columns.filter(c => c !== report.file_column)
  const inProgress = ['queued', 'running'].includes(job.status)

  async function copy() {
    try { await navigator.clipboard.writeText(item.markdown); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }

  return <div className="space-y-5">
    <section className="card p-6">
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div className="min-w-0">
          <p className={`eyebrow ${job.status === 'failed' ? 'text-removed' : inProgress ? 'text-amber' : 'text-added'}`}>{inProgress ? 'Analysis running' : job.status === 'cancelled' ? 'Analysis stopped' : job.status === 'failed' ? 'Analysis failed' : 'Analysis complete'}</p>
          <h2 className="text-2xl font-semibold mt-2 break-all">{job.title}</h2>
          <p className="text-muted text-xs mt-2">{new Date(job.created_at).toLocaleString()} · {job.deployment}{job.provider_label ? ` · ${job.provider_label}` : ''} · {job.workspace_name}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(remaining > 0 && !inProgress || showStop) && <button className="btn" onClick={running ? onStop : onRetry} disabled={stopping}>
            {running ? <Square size={15} /> : <RotateCcw size={15} />}{stopping ? 'Stopping…' : running ? 'Stop' : `Retry ${remaining} unfinished`}
          </button>}
          <a className="btn" href={sonarDownloadUrl(job.id, 'pdf')}><ArrowDownToLine size={15} />PDF report</a>
          <a className="btn-primary" href={sonarDownloadUrl(job.id, 'md')}><ArrowDownToLine size={15} />Markdown report</a>
          <a className="btn" href={sonarDownloadUrl(job.id, 'json')} aria-label="Download JSON"><FileJson size={15} />JSON</a>
        </div>
      </div>
      <div className="mt-5">
        <div className="flex justify-between text-xs text-muted mb-2"><span>{inProgress ? job.stage : `${job.counts.done} of ${job.counts.files} files analysed${job.counts.failed ? `, ${job.counts.failed} failed` : ''}`}</span><span>{number(job.counts.issues)} issues</span></div>
        <div className="sonar-progress"><span style={{ width: `${pct}%` }} className={job.counts.failed && !inProgress ? 'bg-amber' : 'bg-accent'} /></div>
      </div>
      {job.error && <p className="error-box mt-4">{job.error}</p>}
      <div className="grid grid-cols-2 gap-3 mt-5">
        <div className="bg-elevated/60 rounded-lg p-4"><p className="text-xs text-muted">Total input tokens</p><p className="text-2xl font-semibold mt-1">{number(job.usage?.input_tokens)}</p></div>
        <div className="bg-elevated/60 rounded-lg p-4"><p className="text-xs text-muted">Total output tokens</p><p className="text-2xl font-semibold mt-1">{number(job.usage?.output_tokens)}</p></div>
      </div>
      {job.usage?.unreported_requests > 0 && <p className="text-xs text-amber mt-3">Totals include reported usage only; {number(job.usage.unreported_requests)} interrupted or failed request(s) did not return usage.</p>}
      <p className="text-[11px] text-muted mt-3">{number(job.usage?.requests)} model calls · {number(job.usage?.input_tokens)} input / {number(job.usage?.output_tokens)} output tokens · {money(job.cost?.complete ? job.cost?.total_usd : job.cost?.known_subtotal_usd)}{job.cost?.complete ? '' : ' (subtotal)'}</p>
    </section>

    <div className="grid xl:grid-cols-[280px_minmax(0,1fr)] gap-5 items-start">
      <nav className="card p-2 xl:sticky xl:top-4" aria-label="Analysed files">
        {job.items.map(entry => <button key={entry.index} onClick={() => onPick(entry.index)}
          className={`w-full flex items-start gap-2.5 text-left rounded-lg px-3 py-2.5 hover:bg-elevated ${entry.index === item.index ? 'bg-elevated' : ''}`}>
          <StatusIcon status={entry.status} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium truncate" title={entry.path}>{baseName(entry.path)}</span>
            <span className="block text-[10px] text-muted truncate">{entry.issue_count} issue{entry.issue_count === 1 ? '' : 's'} · {entry.path}</span>
            <span className="block text-[10px] text-muted mt-1">{entry.usage ? `${number(entry.usage.input_tokens)} input / ${number(entry.usage.output_tokens)} output tokens` : 'Token usage not recorded'}{entry.usage?.unreported_requests > 0 ? ' (partial)' : ''}</span>
          </span>
        </button>)}
      </nav>

      <section className="card min-w-0">
        <div className="p-5 border-b border-line">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold font-mono text-sm break-all">{item.path}</h3>
              <p className="text-[11px] text-muted break-all mt-1">SonarQube: {item.sonar_path}{item.lines ? ` · ${number(item.lines)} lines` : ''}</p>
            </div>
            {item.status === 'done' && <button className="btn" onClick={copy}>{copied ? <Check size={15} /> : <ClipboardCopy size={15} />}{copied ? 'Copied' : 'Copy fixes'}</button>}
          </div>
          <p className="text-xs text-muted mt-3">{item.usage ? `${number(item.usage.input_tokens)} input / ${number(item.usage.output_tokens)} output tokens · ${number(item.usage.requests)} model calls (all attempts)` : 'Per-file token usage was not recorded for this saved run.'}{item.usage?.unreported_requests > 0 ? ' · Usage incomplete' : ''}</p>
          <div className="flex flex-wrap gap-1.5 mt-3">{sortSev(Object.entries(item.severities || {})).map(([sev, n]) => <Severity key={sev} value={sev} count={n} />)}</div>
        </div>
        <details className="border-b border-line" open={item.status !== 'done'}>
          <summary className="px-5 py-3 text-xs font-medium cursor-pointer">SonarQube findings sent with this file ({item.issue_count})</summary>
          <div className="overflow-x-auto px-5 pb-4">
            <table className="report-table sonar-table">
              <thead><tr><th>#</th>{shown.map(c => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{item.issues.map((issue, i) => <tr key={i}><td className="text-muted">{i + 1}</td>{shown.map(c => <td key={c} className={c === report.message_column ? 'min-w-[280px]' : 'whitespace-nowrap'}>
                {c === report.severity_column ? <Severity value={issue[c] || 'UNSPECIFIED'} /> : c === report.rule_column ? <span className="font-mono text-[11px]">{issue[c]}</span> : issue[c]}
              </td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
        <div className="p-6">
          {item.status === 'done' && <>
            {item.context_mode === 'excerpts' && <p className="text-xs text-amber mb-4 flex gap-2"><AlertTriangle size={14} className="shrink-0 mt-0.5" />This file is larger than the context window, so the fixes were based on the code around each flagged line.</p>}
            <SonarChanges item={item} />
            <MarkdownReport text={item.markdown} />
          </>}
          {['failed', 'cancelled'].includes(item.status) && <div role="alert" className="error-box">{item.error || 'This file could not be analysed.'}</div>}
          {['pending', 'running'].includes(item.status) && <div className="py-12 flex flex-col items-center text-center text-muted">
            <LoaderCircle size={24} className={`mb-4 ${item.status === 'running' ? 'animate-spin text-sky-400' : 'opacity-40'}`} />
            <p className="text-sm">{item.status === 'running' ? 'Analysing this file and its issues…' : 'Waiting for its turn.'}</p>
          </div>}
        </div>
      </section>
    </div>
  </div>
}
