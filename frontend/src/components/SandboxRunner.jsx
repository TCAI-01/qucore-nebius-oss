import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ClipboardCopy, KeyRound, LoaderCircle, Pencil, Play, RefreshCw, RotateCcw, Sparkles, Square, Terminal, WandSparkles } from 'lucide-react'
import { api } from '../api.js'

const LABELS = { nebius: 'Nebius sandbox' }
const ACTIVE = 'running'
// A request that never answers must not leave the panel spinning: give up after `ms` and say so.
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} seconds. Check that the backend is running, then try again.`)), ms))])
const STATUS_TEXT = { completed: 'Finished', failed: 'Failed', stopped: 'Stopped', timeout: 'Timed out' }

const RUNTIME_LABELS = { python: 'Python', node: 'Node.js' }

// Runs a small Python or Node.js program in the remote sandbox. The Run button becomes Stop while it runs.
// QuSolids actions on the program:
//   New demo     onNewDemo(): the model writes a fresh program for the finding (replaces this one)
//   Edit / Done  edit the program by hand (read-only otherwise); "Undo edits" goes back to the program as written
//   Fix with AI  onFix({code, runtime, stdout, stderr, error, exit_code}): after a failed run, the model rewrites the
//                program from its code and the error it produced
export default function SandboxRunner({ code: initial, settings, onConfigure, runtime = 'python', onNewDemo, onFix }) {
  const [code, setCode] = useState(initial)
  const [editing, setEditing] = useState(false)
  const [working, setWorking] = useState('')   // 'new' | 'fix' while the model writes a program
  const [aiError, setAiError] = useState('')
  const [run, setRun] = useState(null)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [copied, setCopied] = useState(false)
  const [copiedOut, setCopiedOut] = useState(false)
  const timer = useRef(null)
  const mounted = useRef(true)
  const wantStop = useRef(false)
  const attempt = useRef(0)       // counts Run / Stop clicks so an old request cannot overwrite a newer state
  const activeId = useRef(null)   // the run the panel is following; null after Stop
  const provider = settings?.sandbox_provider || 'nebius'
  const ready = Boolean(settings?.has_nebius_api_key && (settings?.has_nebius_project_id || settings?.nebius_project_id))
  const language = RUNTIME_LABELS[runtime] || 'Python'
  const running = starting || run?.status === ACTIVE
  const busy = running || Boolean(working)

  // A new or fixed program arrived from the parent: show it, clear the old output, leave edit mode.
  useEffect(() => { setCode(initial); setRun(null); setEditing(false) }, [initial])

  // Set the flag on every mount, not only at creation: React.StrictMode (development) mounts, unmounts and
  // mounts again, and a flag that stayed false made the panel ignore the backend's answer and spin forever.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(timer.current) }
  }, [])
  useEffect(() => {
    if (!running) return undefined
    setSeconds(0)
    const tick = setInterval(() => setSeconds(s => s + 1), 1000)
    return () => clearInterval(tick)
  }, [running])

  const poll = useCallback(function next(id, misses = 0) {
    timer.current = setTimeout(async () => {
      try {
        const snapshot = await within(api.sandboxGet(id), 20000, 'The backend')
        if (!mounted.current || activeId.current !== id) return
        setRun(snapshot)
        if (snapshot.status === ACTIVE) next(id, 0)
        else setStopping(false)
      } catch (err) {
        if (!mounted.current || activeId.current !== id) return
        if (misses < 4) { next(id, misses + 1); return }
        setRun(current => ({ ...current, status: 'failed', error: err.message }))
        setStopping(false)
      }
    }, 700)
  }, [])

  async function start() {
    wantStop.current = false
    activeId.current = null
    const mine = ++attempt.current
    setStarting(true)
    setStopping(false)
    setRun({ status: ACTIVE, stdout: '', stderr: '', error: null, stage: 'Sending the program to the backend' })
    try {
      const snapshot = await within(api.sandboxRun(code, runtime), 30000, 'The backend')
      if (!mounted.current) return
      if (mine !== attempt.current) { api.sandboxStop(snapshot.id).catch(() => {}); return }  // stopped before the run had an id
      activeId.current = snapshot.id
      setRun(snapshot)
      poll(snapshot.id)
    } catch (err) {
      if (mine !== attempt.current) return
      if (mounted.current) setRun({ status: 'failed', stdout: '', stderr: '', error: err.message })
    } finally {
      if (mounted.current && mine === attempt.current) setStarting(false)
    }
  }

  // Stop ends the panel's run right away; the backend is told in the background and kills the worker.
  function stop() {
    wantStop.current = true
    attempt.current += 1
    activeId.current = null
    clearTimeout(timer.current)
    const id = run?.id
    setStopping(false)
    setStarting(false)
    setRun(current => ({ ...current, status: 'stopped', stage: '', stdout: current?.stdout || '', stderr: current?.stderr || '', error: null }))
    if (id) within(api.sandboxStop(id), 10000, 'The backend').catch(() => {})
  }

  async function ask(kind) {
    const action = kind === 'fix' ? onFix : onNewDemo
    if (!action || busy) return
    setWorking(kind); setAiError('')
    try {
      await action(kind === 'fix'
        ? { code, runtime, stdout: run?.stdout || '', stderr: run?.stderr || '', error: run?.error || '', exit_code: run?.exit_code ?? null }
        : undefined)
    } catch (err) {
      if (mounted.current) setAiError(err.message)
    } finally {
      if (mounted.current) setWorking('')
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Tab' && !event.shiftKey && editing && !running) {
      event.preventDefault()
      const el = event.currentTarget
      const { selectionStart: from, selectionEnd: to } = el
      setCode(code.slice(0, from) + '    ' + code.slice(to))
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = from + 4 })
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      if (running) { if (!stopping) stop() } else if (ready && code.trim()) start()
    }
  }

  const rows = Math.max(7, Math.min(24, code.split('\n').length + 1))
  const done = run && run.status !== ACTIVE
  const label = LABELS[run?.provider || provider] || 'sandbox'
  const exitNote = done && run.exit_code != null ? ` · exit code ${run.exit_code}` : ''
  const tone = !done ? '' : run.status === 'completed' ? 'sd-status-ok' : run.status === 'stopped' ? 'sd-status-warn' : 'sd-status-bad'
  const failed = done && (run.status === 'failed' || run.status === 'timeout' || (run.exit_code != null && run.exit_code !== 0))

  return <div className="sd-sandbox">
    <div className="sd-sandbox-bar">
      <span className="flex items-center gap-2 text-xs font-semibold"><Terminal size={14} className="text-sky-400" />Sandbox · {language}
        <span className="pill">{LABELS[provider]}</span></span>
      <span className="flex items-center gap-1.5">
        {onNewDemo && <button type="button" className="btn-small" onClick={() => ask('new')} disabled={busy}
          title="Reset: the model writes a new program for this finding (replaces this one)">
          {working === 'new' ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} />}{working === 'new' ? 'Writing…' : 'Reset'}</button>}
        <button type="button" className={`btn-small ${editing ? 'ring-1 ring-sky-400' : ''}`} onClick={() => setEditing(!editing)} disabled={busy}
          title={editing ? 'Stop editing' : 'Edit the program by hand'}>
          {editing ? <Check size={13} /> : <Pencil size={13} />}{editing ? 'Done' : 'Edit'}</button>
        {code !== initial && <button type="button" className="btn-small" onClick={() => { setCode(initial); setRun(null) }} disabled={busy}
          title="Undo your edits: back to the program as written"><RotateCcw size={13} />Undo edits</button>}
        {onFix && <button type="button" className="btn-small" onClick={() => ask('fix')} disabled={busy || !failed}
          title={failed ? 'Fix: the model rewrites the program from the error it produced' : 'Run the program first; Fix uses the error of a failed run'}>
          {working === 'fix' ? <LoaderCircle size={13} className="animate-spin" /> : <WandSparkles size={13} />}{working === 'fix' ? 'Fixing…' : 'Fix with AI'}</button>}
        <button type="button" className="btn-small" onClick={async () => {
          try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
        }}>{copied ? <Check size={13} /> : <ClipboardCopy size={13} />}{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn-primary !py-1.5 !px-3.5 !text-xs" disabled={stopping || Boolean(working) || (!running && (!ready || !code.trim()))}
          onClick={running ? stop : start} title="Ctrl+Enter">
          {stopping ? <LoaderCircle size={14} className="animate-spin" /> : running ? <Square size={13} /> : <Play size={13} />}
          {stopping ? 'Stopping…' : running ? 'Stop' : 'Run'}
        </button>
      </span>
    </div>
    {!ready && <div className="sd-sandbox-warn">
      <KeyRound size={14} className="shrink-0 mt-0.5" />
      <span>Add your Nebius API key and project ID in Credentials &gt; Code sandbox to run this program.</span>
      {onConfigure && <button type="button" className="btn-small ml-auto shrink-0" onClick={onConfigure}>Open Credentials</button>}
    </div>}
    {aiError && <p role="alert" className="error-box !rounded-none !border-x-0">{aiError}</p>}
    {editing && <p className="sd-console-hint !my-0 px-4 py-1.5 border-b border-line flex items-center gap-1.5"><Pencil size={11} />Editing: change the program, then Run (Ctrl+Enter).</p>}
    <textarea className="sd-editor" value={code} rows={rows} spellCheck={false} readOnly={busy || !editing} aria-label={`${language} program to run in the sandbox`}
      onChange={event => setCode(event.target.value)} onKeyDown={onKeyDown} />
    <div className="sd-console" aria-live="polite">
      {!run && <p className="sd-console-hint">Press Run to execute this program in the {LABELS[provider]}. It runs remotely, never on this computer. Output appears here.</p>}
      {run?.status === ACTIVE && <div className="sd-console-hint flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2"><LoaderCircle size={13} className="animate-spin" />
          {run.stage || 'Starting'} · {label} · {seconds}s{seconds > 15 ? ` (a first run can take longer while the ${language} image is imported into your Nebius project)` : ''}</span>
        <button type="button" className="btn-small ml-auto" onClick={stop} disabled={stopping} title="Stop this run and cancel it at the provider">
          {stopping ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={12} />}{stopping ? 'Stopping…' : 'Stop'}</button>
      </div>}
      {run?.status === ACTIVE && run.log?.length > 0 && <details className="sd-console-hint !mt-1">
        <summary className="cursor-pointer truncate" title={run.log[run.log.length - 1]}>{run.log[run.log.length - 1]}</summary>
        <pre className="sd-err !mt-2">{run.log.join('\n')}</pre></details>}
      {run?.stdout ? <>
        <div className="flex items-center justify-between gap-3 mb-2">
          <span className="sd-console-hint !m-0 font-semibold uppercase tracking-wider text-[10px]">Output · stdout</span>
          <button type="button" className="btn-small" onClick={async () => {
            try { await navigator.clipboard.writeText(run.stdout); setCopiedOut(true); setTimeout(() => setCopiedOut(false), 1500) } catch { /* blocked */ }
          }}>{copiedOut ? <Check size={13} /> : <ClipboardCopy size={13} />}{copiedOut ? 'Copied' : 'Copy output'}</button>
        </div>
        <Narrated text={run.stdout} />
      </> : null}
      {run?.stderr ? <pre className="sd-err">{run.stderr}</pre> : null}
      {run?.error && run.status !== 'stopped' ? <pre className="sd-err">{run.error}</pre> : null}
      {done && run.status === 'completed' && !run.stdout && !run.stderr && <p className="sd-console-hint">The program finished without printing anything.</p>}
      {done && run.log?.length > 0 && (run.status === 'failed' || run.status === 'timeout') && <details className="sd-console-hint mt-2">
        <summary className="cursor-pointer">Connection details ({run.log.length} lines)</summary>
        <pre className="sd-err !mt-2">{run.log.join('\n')}</pre></details>}
      {failed && onFix && <div className="sd-console-hint mt-3 flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5"><Sparkles size={13} />The run failed. Fix with AI rewrites the program from this error, or Edit it yourself.</span>
        <button type="button" className="btn-small ml-auto" onClick={() => ask('fix')} disabled={busy}>
          {working === 'fix' ? <LoaderCircle size={13} className="animate-spin" /> : <WandSparkles size={13} />}{working === 'fix' ? 'Fixing…' : 'Fix with AI'}</button>
      </div>}
      {done && <div className={`sd-console-foot ${tone}`}>
        {STATUS_TEXT[run.status] || run.status}{exitNote}
        {run.duration_ms != null ? ` · ${(run.duration_ms / 1000).toFixed(1)} s` : ''} · {label}{run.image ? ` · ${run.image}` : ''}
      </div>}
    </div>
  </div>
}

// Program output, laid out so a narrated demo reads like a story: === headings ===, [1] numbered steps, OK / FAIL lines.
function Narrated({ text }) {
  const lines = text.replace(/\n+$/, '').split('\n')
  return <div className="sd-out sd-narrated">{lines.map((line, i) => {
    const t = line.trim()
    const head = /^=+\s*(.+?)\s*=+$/.exec(t)
    if (head) return <div key={i} className="sd-n-head">{head[1]}</div>
    const step = /^\[(\d+)\]\s*(.*)$/.exec(t)
    if (step) return <div key={i} className="sd-n-step"><span>{step[1]}</span>{step[2]}</div>
    if (/^(OK|PASS|✓|✔)\b/i.test(t)) return <div key={i} className="sd-n-ok">{line}</div>
    if (/^(FAIL|ERROR|✗|✘|WRONG)\b/i.test(t)) return <div key={i} className="sd-n-bad">{line}</div>
    if (/^(BEFORE|OLD|AFTER|NEW)\b/i.test(t)) return <div key={i} className="sd-n-label">{line}</div>
    return <div key={i} className="sd-n-line">{line || ' '}</div>
  })}</div>
}
