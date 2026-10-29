import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine, Check, Columns2, FilePlus2, FileCode2, GitCommitHorizontal, LoaderCircle, Replace, Rows2, RotateCcw, Save,
  Undo2, X,
} from 'lucide-react'
import { DiffEditor } from '@monaco-editor/react'
import monaco from '../monacoSetup.js'
import { api } from '../api.js'
import BrandLoader from './BrandLoader.jsx'

// The language comes from Monaco's own registry (file extensions and file names of every bundled language),
// so any file type Monaco knows is coloured without a list kept here.
function languageOf(path) {
  const name = String(path || '').split('/').pop().toLowerCase()
  const known = monaco.languages.getLanguages()
  const byName = known.find(l => (l.filenames || []).some(f => f.toLowerCase() === name))
  if (byName) return byName.id
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  return (ext && known.find(l => (l.extensions || []).some(e => e.toLowerCase() === ext))?.id) || 'plaintext'
}
const STATUS = { draft: 'Draft', saved: 'Saved', replaced: 'Applied', reverted: 'Reverted' }

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

function DiffStat({ stats }) {
  const added = stats?.added || 0
  const removed = stats?.removed || 0
  const total = added + removed
  const green = total ? Math.round((added / total) * 5) : 0
  return <span className="chg-diffstat" title={`${added} added, ${removed} removed`}>
    <b className="chg-add">+{added}</b><b className="chg-del">−{removed}</b>
    <span className="chg-squares" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <i key={i} className={!total ? '' : i < green ? 'on-add' : 'on-del'} />)}</span>
  </span>
}

// Reviews one change: before / after in a diff editor (the right side is editable), the file's commit history,
// and Save, Download, Replace (write into the folder) and Revert (restore the original).
export default function ChangeReview({ modal, workspace, light, onClose, onError, onChanged }) {
  const [rec, setRec] = useState(null)                 // the saved change being shown (null while it is a draft)
  const [draft, setDraft] = useState(modal.mode === 'draft' ? modal.draft : null)
  const [text, setText] = useState(modal.mode === 'draft' ? modal.draft.modified : '')
  const [list, setList] = useState([])
  const [scope, setScope] = useState(modal.mode === 'history' ? 'all' : 'file')
  const [busy, setBusy] = useState('')
  const [inline, setInline] = useState(false)
  const [loading, setLoading] = useState(modal.mode !== 'draft')
  const [stats, setStats] = useState(modal.mode === 'draft' ? modal.draft.stats : null)
  const editor = useRef(null)
  const request = modal.request || {}
  const path = rec?.path || draft?.path || ''
  const original = rec ? rec.original : draft?.original ?? ''
  const initial = rec ? rec.modified : draft?.modified ?? ''
  const isNew = rec ? rec.is_new : Boolean(draft?.is_new)
  const status = rec?.status || 'draft'
  const dirty = rec ? text !== rec.modified : true
  const root = workspace?.root

  const refreshList = useCallback(async () => {
    try { setList(await api.changesList({ ...(root ? { root } : {}), ...(scope === 'file' && path ? { path } : {}) })) } catch { /* the list is optional */ }
  }, [root, scope, path])
  useEffect(() => { refreshList() }, [refreshList])

  // Monaco logs an error if a diff editor's models are disposed while still attached: detach them first.
  const detach = () => { try { editor.current?.setModel(null) } catch { /* already gone */ } }
  useEffect(() => detach, []) // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback(async id => {
    detach()
    setLoading(true)
    try {
      const full = await api.changeGet(id)
      setRec(full); setDraft(null); setText(full.modified); setStats(full.stats)
    } catch (err) { onError(err.message) } finally { setLoading(false) }
  }, [onError])
  useEffect(() => {
    if (modal.mode === 'change') open(modal.changeId)
    else if (modal.mode === 'history') api.changesList(root ? { root } : {}).then(items => (items[0] ? open(items[0].id) : setLoading(false))).catch(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow }
  }, [onClose])

  function onMount(diff) {
    editor.current = diff
    const modified = diff.getModifiedEditor()
    setText(modified.getValue())
    modified.onDidChangeModelContent(() => setText(modified.getValue()))
    diff.onDidUpdateDiff(() => {
      let added = 0
      let removed = 0
      for (const c of diff.getLineChanges() || []) {
        if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1
        if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1
      }
      setStats({ added, removed })
    })
  }

  async function run(name, action) {
    setBusy(name)
    try { return await action() } catch (err) { onError(err.message); return null } finally { setBusy('') }
  }

  // Saves the current text as a change (or updates the saved one) and returns it.
  async function persist() {
    if (!workspace && !rec) { onError('Open the codebase folder to save this change.'); return null }
    const saved = rec
      ? (dirty ? await api.changeUpdate(rec.id, text) : rec)
      : await api.changeSave({ workspace_id: workspace.id, path, title: request.title || `Change ${path}`, source: request.source || 'manual', content: text, is_new: isNew })
    setRec(saved); setDraft(null); setStats(saved.stats)
    await refreshList(); onChanged?.()
    return saved
  }

  const save = () => run('save', persist)

  async function withForce(id, call, name) {
    try { return await call(id, false) } catch (err) {
      if (/anyway\?$/.test(err.message) && window.confirm(`${err.message}`)) return call(id, true)
      throw err
    }
  }
  const replace = () => run('replace', async () => {
    if (!window.confirm(`Replace ${path} in your folder with this version?\n\nThe original is kept, and you can Revert at any time.`)) return null
    const saved = await persist()
    if (!saved) return null
    const done = await withForce(saved.id, api.changeReplace, 'replace')
    setRec(done); await refreshList(); onChanged?.()
    return done
  })
  const revert = () => run('revert', async () => {
    if (!window.confirm(`Restore ${path} to how it was before this change?`)) return null
    const done = await withForce(rec.id, api.changeRevert, 'revert')
    setRec(done); setText(done.modified); await refreshList(); onChanged?.()
    return done
  })

  function download() {
    const body = rec?.newline === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    Object.assign(document.createElement('a'), { href: url, download: path.split('/').pop() || 'file.txt' }).click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const language = useMemo(() => languageOf(path), [path])
  const events = rec?.events || []
  const canSave = !loading && (!rec ? true : dirty && status !== 'replaced')
  const unsaved = !rec || dirty

  return <div className="chg-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !unsaved) onClose() }}>
    <div className="chg-modal" role="dialog" aria-modal="true" aria-label={`Review change to ${path || 'file'}`}>
      <aside className="chg-rail" aria-label="Change history">
        <div className="chg-rail-head">
          <span className="flex items-center gap-2 text-sm font-semibold"><GitCommitHorizontal size={16} className="text-sky-400" />History</span>
          <span className="chg-seg" role="tablist">
            <button type="button" role="tab" aria-selected={scope === 'file'} className={scope === 'file' ? 'on' : ''} onClick={() => setScope('file')} disabled={!path}>This file</button>
            <button type="button" role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All files</button>
          </span>
        </div>
        <ol className="chg-commits">
          {!rec && draft && <li className="chg-commit chg-commit-on"><span className="chg-dot chg-dot-draft" />
            <div className="min-w-0"><p className="chg-msg">{request.title || `Change ${path}`}</p>
              <p className="chg-meta">Draft · not saved yet</p></div></li>}
          {list.map(item => <li key={item.id} className={`chg-commit ${rec?.id === item.id ? 'chg-commit-on' : ''}`}>
            <span className={`chg-dot chg-dot-${item.status}`} />
            <button type="button" className="min-w-0 text-left flex-1" onClick={() => open(item.id)}>
              <span className="chg-msg block">{item.title}</span>
              <span className="chg-meta block truncate">{scope === 'all' ? `${item.path} · ` : ''}{item.source} · {ago(item.created_at)} · <code>{item.id.slice(0, 7)}</code></span>
              <span className="flex items-center gap-2 mt-1.5"><span className={`chg-status chg-status-${item.status}`}>{STATUS[item.status] || item.status}</span><DiffStat stats={item.stats} /></span>
            </button>
          </li>)}
          {!list.length && (rec || !draft) && <li className="text-xs text-muted px-4 py-6">No saved changes yet. Save a change to start the history.</li>}
        </ol>
      </aside>

      <section className="chg-main">
        <header className="chg-head">
          <div className="min-w-0">
            <p className="eyebrow flex items-center gap-2">{isNew ? <FilePlus2 size={12} /> : <FileCode2 size={12} />}{isNew ? 'New file' : 'Change'} · {rec?.source || request.source || 'manual'}</p>
            <h3 className="font-mono text-sm font-semibold break-all mt-1">{path || 'No change selected'}</h3>
            {(rec?.title || request.title) && <p className="text-xs text-muted mt-1">{rec?.title || request.title}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {path && <span className={`chg-status chg-status-${status}`}>{STATUS[status]}</span>}
            {path && <DiffStat stats={stats} />}
            <button type="button" className="btn-small" onClick={() => setInline(!inline)} title="Switch between side-by-side and inline">{inline ? <Columns2 size={14} /> : <Rows2 size={14} />}{inline ? 'Side by side' : 'Inline'}</button>
            <button type="button" className="btn-icon" onClick={() => { if (!unsaved || window.confirm('Close without saving your edits?')) onClose() }} aria-label="Close"><X size={17} /></button>
          </div>
        </header>
        {events.length > 0 && <ol className="chg-events" aria-label="Activity">{events.map((e, i) => <li key={i}><b>{e.action}</b> {ago(e.at)}</li>)}</ol>}

        <div className="chg-diff">
          {loading && <div className="chg-center"><BrandLoader size="sm" label="Loading…" /></div>}
          {!loading && !path && <div className="chg-center">Choose a change from the history.</div>}
          {!loading && path && <>
            <div className="chg-sides" aria-hidden="true"><span>Before{isNew ? ' (new file)' : ''}</span><span>After · you can edit this side</span></div>
            <DiffEditor key={rec?.id || 'draft'} height="100%" language={language} original={original} modified={initial}
              theme={light ? 'vs' : 'vs-dark'} onMount={onMount} keepCurrentOriginalModel={false} keepCurrentModifiedModel={false}
              loading={<div className="chg-center"><BrandLoader size="sm" label="Starting the editor…" /></div>}
              options={{ renderSideBySide: !inline, originalEditable: false, readOnly: status === 'replaced', automaticLayout: true, minimap: { enabled: false },
                scrollBeyondLastLine: false, fontSize: 12.5, renderOverviewRuler: true, ignoreTrimWhitespace: false, padding: { top: 8 },
                diffAlgorithm: 'advanced', enableSplitViewResizing: true, renderIndicators: true }} />
          </>}
        </div>

        <footer className="chg-foot">
          <p className="text-[11px] text-muted leading-snug max-w-[34rem]">
            {status === 'replaced' ? 'This version is in your folder now. Revert restores the original file exactly.'
              : 'Save keeps this version here without touching your folder. Replace writes it into your folder; Revert undoes that.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn" onClick={() => editor.current?.getModifiedEditor().setValue(initial)} disabled={!path || text === initial || status === 'replaced'}>
              <RotateCcw size={14} />Reset edits</button>
            <button type="button" className="btn" onClick={download} disabled={!path}><ArrowDownToLine size={14} />Download</button>
            <button type="button" className="btn" onClick={save} disabled={!canSave || Boolean(busy)}>
              {busy === 'save' ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}{rec && !dirty ? 'Saved' : 'Save'}</button>
            <button type="button" className="btn-primary" onClick={replace} disabled={!path || status === 'replaced' || Boolean(busy)}>
              {busy === 'replace' ? <LoaderCircle size={14} className="animate-spin" /> : <Replace size={14} />}Replace in folder</button>
            <button type="button" className="btn-revert" onClick={revert} disabled={status !== 'replaced' || Boolean(busy)}>
              {busy === 'revert' ? <LoaderCircle size={14} className="animate-spin" /> : <Undo2 size={14} />}Revert</button>
          </div>
        </footer>
      </section>
    </div>
  </div>
}
