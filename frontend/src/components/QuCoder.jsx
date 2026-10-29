import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Bot, Check, Code2, FileCode2, FilePlus2, GitCommitHorizontal, History, ImagePlus, KeyRound, LoaderCircle,
  MessageSquarePlus, Paperclip, Save, Send, Sparkles, Square, Trash2, User, X,
} from 'lucide-react'
import { api, qucoderAsk } from '../api.js'
import { prettyEdits } from '../changeParse.js'
import FileTree, { Checkbox, collectFiles } from './FileTree.jsx'
import WorkspacePicker from './WorkspacePicker.jsx'
import QAMarkdown from './QAMarkdown.jsx'
import { useChanges } from './ChangesContext.jsx'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IDEAS = [
  { icon: FilePlus2, title: 'Create something new', text: 'Create a small, well-structured module with docstrings and a unit-test file for the feature I describe next.' },
  { icon: FileCode2, title: 'Improve selected code', text: 'Refactor the selected files to remove duplication and improve naming, without changing behaviour.' },
  { icon: Sparkles, title: 'Add a feature', text: 'Add input validation and clear error messages to the selected files, and show me what changed.' },
]
const fmt = value => Number(value || 0).toLocaleString()
const usd = value => (value == null ? 'not priced' : `$${Number(value).toFixed(value >= 1 ? 2 : 4)}`)
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { const url = String(reader.result); resolve({ id: uid(), name: file.name || 'pasted-image', media_type: file.type, data: url.split(',')[1] || '', url }) }
    reader.onerror = () => reject(new Error('The image could not be read.'))
    reader.readAsDataURL(file)
  })
}

function fromStored(items) {
  return items.map(item => item.role === 'user'
    ? { key: item.id, role: 'user', content: item.content, images: [], imageCount: item.data?.images || 0 }
    : { key: item.id, role: 'assistant', content: item.content, status: item.status === 'streaming' ? 'error' : item.status,
        error: item.status === 'streaming' ? 'This answer was interrupted (backend restart).' : item.data?.error,
        edits: item.data?.edits || [], metrics: item.data?.metrics || null, stage: '' })
}

export default function QuCoder({ workspace, onWorkspace, settings, onError, onConfigure, seed, onSeedUsed }) {
  const { openDraft, openChange, openHistory, refresh } = useChanges()
  const [selected, setSelected] = useState(new Set())
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [question, setQuestion] = useState('')
  const [images, setImages] = useState([])
  const [dragging, setDragging] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [estimate, setEstimate] = useState(null)
  const scroller = useRef(null)
  const stick = useRef(true)
  const input = useRef(null)
  const fileInput = useRef(null)
  const live = useRef({ streamId: null, controller: null, stop: false })
  const pending = useRef({})
  const flushTimer = useRef(null)

  const files = useMemo(() => (workspace ? collectFiles(workspace.tree) : []), [workspace])
  const fileSet = useMemo(() => new Set(files), [files])
  const ready = Boolean(workspace) && Boolean(settings?.configured)

  useEffect(() => { api.qucoderSessions().then(setSessions).catch(() => {}) }, [])
  useEffect(() => { const t = setTimeout(() => setQuestion(draft), 700); return () => clearTimeout(t) }, [draft])
  useEffect(() => {  // keep the box as tall as its text, up to about nine lines
    const el = input.current
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 220)}px` }
  }, [draft])
  useEffect(() => {  // a folder opened again keeps the picked files that still exist
    setSelected(current => { const kept = new Set([...current].filter(p => fileSet.has(p))); return kept.size === current.size ? current : kept })
  }, [workspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // "Fix with QuCoder" from other tabs: preselect the files and prefill the request.
  useEffect(() => {
    if (!seed || !workspace) return
    setSelected(new Set((seed.files || []).filter(p => fileSet.has(p))))
    setDraft(seed.prompt || ''); setQuestion(seed.prompt || '')
    setSessionId(null); setMessages([]); setImages([])
    onSeedUsed?.()
    setTimeout(() => input.current?.focus(), 50)
  }, [seed?.nonce, workspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) { setEstimate(null); return undefined }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api.qucoderPreview({ workspace_id: workspace.id, files: [...selected], question, image_count: images.length, session_id: sessionId }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setEstimate(result) }).catch(() => { if (!controller.signal.aborted) setEstimate(null) })
    }, 450)
    return () => { clearTimeout(timer); controller.abort() }
  }, [workspace?.id, selected, question, images.length, sessionId, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [messages])

  const update = useCallback((key, patch) => setMessages(items => items.map(m => (m.key === key ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m))), [])
  const flush = useCallback(() => {
    clearTimeout(flushTimer.current); flushTimer.current = null
    const chunks = pending.current; pending.current = {}
    if (Object.keys(chunks).length) setMessages(items => items.map(m => (chunks[m.key] ? { ...m, content: m.content + chunks[m.key] } : m)))
  }, [])
  const append = useCallback((key, text) => { pending.current[key] = (pending.current[key] || '') + text; if (!flushTimer.current) flushTimer.current = setTimeout(flush, 40) }, [flush])

  async function addImages(list) {
    const incoming = [...list].filter(f => f?.type?.startsWith('image/'))
    if (!incoming.length) return
    const problems = []
    const accepted = incoming.filter(f => {
      if (!IMAGE_TYPES.includes(f.type)) { problems.push(`${f.name || 'image'}: use PNG, JPEG, GIF or WebP`); return false }
      if (f.size > MAX_IMAGE_BYTES) { problems.push(`${f.name || 'image'}: larger than 5 MB`); return false }
      return true
    })
    try { const read = await Promise.all(accepted.slice(0, Math.max(0, MAX_IMAGES - images.length)).map(readImage)); setImages(c => [...c, ...read].slice(0, MAX_IMAGES)) } catch (err) { problems.push(err.message) }
    if (problems.length) onError(problems.join('. '))
  }
  function onPaste(event) {
    const items = [...(event.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/'))
    if (!items.length) return
    event.preventDefault(); addImages(items.map(i => i.getAsFile()).filter(Boolean))
  }

  function newChat() { if (!streaming) { setSessionId(null); setMessages([]); setDraft(''); setImages([]); input.current?.focus() } }
  async function openSession(id) {
    if (streaming) return
    try {
      const data = await api.qucoderSession(id)
      setSessionId(id); setMessages(fromStored(data.messages)); stick.current = true
      const last = [...data.messages].reverse().find(m => m.role === 'user' && m.data?.files)
      if (last) setSelected(new Set(last.data.files.filter(p => fileSet.has(p))))
    } catch (err) { onError(err.message) }
  }
  async function removeSession(id) {
    try { await api.qucoderDeleteSession(id); setSessions(items => items.filter(s => s.id !== id)); if (sessionId === id) newChat() } catch (err) { onError(err.message) }
  }

  async function stop() {
    live.current.stop = true; setStopping(true)
    const { streamId, controller } = live.current
    try { if (streamId) await api.qucoderStop(streamId) } catch { /* the abort below still ends it */ }
    setTimeout(() => { if (live.current.controller === controller) controller?.abort() }, 5000)
  }

  async function send(text = draft) {
    const content = text.trim()
    if (!content || streaming || !ready) return
    const attached = images
    setDraft(''); setQuestion(''); setImages([]); stick.current = true; setStreaming(true); setStopping(false)
    live.current = { streamId: null, controller: new AbortController(), stop: false }
    const key = uid()
    setMessages(items => [...items, { key: uid(), role: 'user', content, images: attached.map(i => ({ url: i.url, name: i.name })), imageCount: attached.length },
      { key, role: 'assistant', content: '', status: 'streaming', stage: 'Starting…', edits: [], metrics: null }])
    try {
      await qucoderAsk({ workspace_id: workspace.id, files: [...selected], question: content, session_id: sessionId, include_history: true,
        images: attached.map(({ name, media_type, data }) => ({ name, media_type, data })) }, (event, data) => {
        if (event === 'meta') {
          live.current.streamId = data.stream_id
          setSessionId(data.session.id)
          setSessions(items => [data.session, ...items.filter(s => s.id !== data.session.id)])
          update(key, { id: data.message_id, question: content })
          if (live.current.stop) api.qucoderStop(data.stream_id).catch(() => {})
        } else if (event === 'status') update(key, { stage: data.stage })
        else if (event === 'delta') append(key, data.text)
        else if (event === 'usage') update(key, { liveUsage: data.usage })
        else if (event === 'edits') { flush(); update(key, { edits: data.edits }) }
        else if (event === 'done') { flush(); update(key, { status: data.status, error: data.error, edits: data.edits, metrics: data.metrics, stage: '' }); refresh() }
        else if (event === 'error') { flush(); update(key, { status: 'error', error: data.message, stage: '' }) }
      }, live.current.controller.signal)
      flush()
      update(key, m => (m.status === 'streaming' ? { status: 'error', error: 'The answer ended unexpectedly.', stage: '' } : {}))
    } catch (err) {
      flush()
      update(key, err.name === 'AbortError' ? { status: 'stopped', stage: '' } : { status: 'error', error: err.message, stage: '' })
    } finally {
      live.current.controller = null; live.current.streamId = null
      setStreaming(false); setStopping(false)
      api.qucoderSessions().then(setSessions).catch(() => {})
    }
  }

  const selectPaths = (paths, enabled) => setSelected(current => { const next = new Set(current); paths.forEach(p => (enabled ? next.add(p) : next.delete(p))); return next })

  return <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)] lg:h-[calc(100vh-97px)]">
    <aside className="bg-panel border-r border-line flex flex-col min-w-0 lg:overflow-y-auto">
      <div className="shrink-0"><WorkspacePicker workspace={workspace} onWorkspace={onWorkspace} onError={onError} label="01 / Folder" /></div>
      {workspace && <>
        <div className="px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-center justify-between gap-3">
            <p className="eyebrow">02 / Reference files</p><span className="pill">{selected.size} picked</span>
          </div>
          <p className="text-[11px] text-muted mt-2 leading-relaxed">QuCoder reads the files you tick, in full. It can also create new files anywhere in the folder.</p>
          <label className="flex items-center gap-2 text-xs text-muted mt-3">
            <Checkbox checked={files.length > 0 && selected.size === files.length} mixed={selected.size > 0 && selected.size < files.length}
              disabled={!files.length} onChange={() => selectPaths(files, selected.size !== files.length)} />
            Select all eligible files <span className="ml-auto">{files.length}</span>
          </label>
        </div>
        <div className="flex-1 min-h-[260px] overflow-auto border-b border-line">
          <FileTree tree={workspace.tree} selected={selected} selectPaths={selectPaths} activePath={null} onOpen={path => selectPaths([path], !selected.has(path))} />
        </div>
      </>}
      <div className="p-5 mt-auto shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="eyebrow flex gap-2 items-center"><History size={13} />Chats</h2>
          <button type="button" className="btn-small" onClick={newChat} disabled={streaming}><MessageSquarePlus size={13} />New chat</button>
        </div>
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {sessions.map(item => <div key={item.id} className={`group flex items-start gap-1 rounded-lg hover:bg-elevated ${sessionId === item.id ? 'bg-elevated' : ''}`}>
            <button type="button" onClick={() => openSession(item.id)} disabled={streaming} className="flex-1 min-w-0 text-left p-3">
              <span className="block truncate text-xs font-medium">{item.title}</span>
              <span className="block text-[10px] text-muted mt-1">{new Date(item.updated_at).toLocaleDateString()} · {item.workspace_name}</span>
            </button>
            <button type="button" className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5 mr-1" title="Delete chat" aria-label="Delete chat" disabled={streaming} onClick={() => removeSession(item.id)}><Trash2 size={13} /></button>
          </div>)}
          {!sessions.length && <p className="text-xs text-muted">Your chats are saved here.</p>}
        </div>
      </div>
    </aside>

    <main className="flex flex-col min-w-0 min-h-[640px] lg:min-h-0">
      <div className="px-5 lg:px-8 py-4 border-b border-line bg-panel/40 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="qc-badge"><Code2 size={18} /></span>
          <div><h1 className="text-xl font-semibold tracking-tight">QuCoder</h1>
            <p className="text-xs text-muted">Describe what you want. Watch the code appear. Review every change before it touches a file.</p></div>
        </div>
        <button type="button" className="btn-small" onClick={openHistory}><GitCommitHorizontal size={14} />Change history</button>
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-4 lg:px-8 py-6"
        onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {!messages.length ? <div className="min-h-[320px] h-full flex flex-col items-center justify-center text-center px-6">
          <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5 mb-5"><Code2 size={34} className="text-sky-400" /></div>
          <h2 className="text-xl font-semibold">What should we build?</h2>
          <p className="text-muted max-w-lg text-sm mt-3 leading-relaxed">Tick the files QuCoder should read, then ask for a change or a new file. You can paste a screenshot too (Ctrl+V).</p>
          {!workspace && <p className="text-xs text-amber mt-4">Open a folder first.</p>}
          {!settings?.configured && <button type="button" className="text-xs text-amber mt-3 flex items-center gap-2" onClick={onConfigure}><KeyRound size={13} />Configure the model in Credentials.</button>}
          <div className="mt-6 grid sm:grid-cols-3 gap-3 w-full max-w-3xl">
            {IDEAS.map(({ icon: Icon, title, text }) => <button key={title} type="button" className="qc-idea" onClick={() => { setDraft(text); input.current?.focus() }}>
              <Icon size={16} className="text-sky-400" /><span className="text-sm font-medium">{title}</span><span className="text-[11px] text-muted leading-snug">{text}</span></button>)}
          </div>
        </div> : <div className="max-w-5xl mx-auto space-y-6">
          {messages.map(m => m.role === 'user' ? <UserBubble key={m.key} message={m} /> : <Reply key={m.key} message={m} selectedCount={selected.size}
            openDraft={openDraft} openChange={openChange} onSaved={refresh} onError={onError} workspace={workspace} />)}
        </div>}
      </div>

      <div className={`border-t border-line bg-panel px-4 lg:px-8 py-4 ${dragging ? 'qa-drop' : ''}`}
        onDragOver={e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragging(true) } }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addImages(e.dataTransfer.files) }}>
        <div className="max-w-5xl mx-auto">
          {images.length > 0 && <div className="flex flex-wrap gap-2 mb-3">{images.map(image => <div key={image.id} className="qa-thumb"><img src={image.url} alt={image.name} />
            <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages(items => items.filter(i => i.id !== image.id))}><X size={12} /></button></div>)}</div>}
          <div className="qa-composer">
            <button type="button" className="btn-icon self-end" title="Attach images (or paste with Ctrl+V)" aria-label="Attach images" disabled={streaming || images.length >= MAX_IMAGES} onClick={() => fileInput.current?.click()}><ImagePlus size={18} /></button>
            <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} multiple className="hidden" onChange={e => { addImages(e.target.files); e.target.value = '' }} />
            <textarea ref={input} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onPaste={onPaste} className="qa-input" aria-label="What should QuCoder do?"
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!streaming) send() } }}
              placeholder={workspace ? 'Ask QuCoder to write or change code…  (Enter to send, Shift+Enter for a new line)' : 'Open a folder first'} disabled={!workspace} />
            <button type="button" className="btn-primary self-end" disabled={stopping || (!streaming && (!draft.trim() || !ready))} onClick={streaming ? stop : () => send()}>
              {stopping ? <LoaderCircle size={16} className="animate-spin" /> : streaming ? <Square size={15} /> : <Send size={15} />}{stopping ? 'Stopping…' : streaming ? 'Stop' : 'Send'}
            </button>
          </div>
          <div className="flex flex-wrap justify-between gap-2 mt-2 text-[11px] text-muted">
            <span className="flex items-center gap-1.5"><Paperclip size={11} />{images.length ? `${images.length} image(s) attached` : 'Paste, drop or attach screenshots (PNG, JPEG, GIF, WebP)'}</span>
            <span>{estimate ? `${selected.size} file(s) · ${fmt(estimate.lines)} lines · ~${fmt(estimate.input_tokens)} input tokens · up to ${usd(estimate.cost_max_usd)}${estimate.cost_complete ? '' : '*'}` : `${selected.size} reference file(s)`}</span>
          </div>
          {estimate && !estimate.fits && <p className="text-[11px] text-amber mt-2 flex gap-1.5"><AlertTriangle size={12} className="shrink-0 mt-0.5" />The picked files are too large for the model's context window. Pick fewer files.</p>}
          {!settings?.configured && <button type="button" className="text-xs text-amber mt-2 flex items-center gap-2" onClick={onConfigure}><KeyRound size={13} />Add the endpoint, API key and model in Credentials.</button>}
        </div>
      </div>
    </main>
  </div>
}

function UserBubble({ message }) {
  return <div className="flex justify-end gap-3">
    <div className="qa-bubble-user">
      {message.images?.length > 0 && <div className="flex flex-wrap gap-2 mb-2">{message.images.map((image, i) => <img key={i} src={image.url} alt={image.name} className="qa-bubble-image" />)}</div>}
      {!message.images?.length && message.imageCount > 0 && <p className="text-[11px] opacity-80 mb-1 flex items-center gap-1"><ImagePlus size={11} />{message.imageCount} image(s) attached</p>}
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
    </div>
    <span className="qa-avatar qa-avatar-user" aria-hidden="true"><User size={15} /></span>
  </div>
}

const NOTE = { stopped: 'Stopped by you. The partial answer is kept.', truncated: 'The answer reached the output limit even after continuing. Ask QuCoder to continue.', filtered: 'The provider content filter stopped this answer.', refused: 'The model declined to answer.' }

function Reply({ message, openDraft, openChange, onSaved, onError, workspace }) {
  const [saved, setSaved] = useState({})
  const [savingAll, setSavingAll] = useState(false)
  const shown = useMemo(() => prettyEdits(message.content), [message.content])
  const edits = (message.edits || []).filter(e => e.path || e.errors?.length)
  const good = edits.filter(e => e.ok)
  const m = message.metrics
  const usage = m?.usage || message.liveUsage
  const title = `QuCoder: ${(message.question || 'requested change').slice(0, 80)}`

  // Every applicable edit is stored in the change history when the answer finishes (change_id);
  // older answers without one open as an unsaved draft instead.
  const inHistory = edit => Boolean(edit.change_id) || Boolean(saved[edit.path])
  async function review(edit) {
    if (edit.change_id) {
      try { await api.changeGet(edit.change_id); openChange(edit.change_id); return } catch { /* deleted from the history: show it as a draft */ }
    }
    openDraft({ path: edit.path, content: edit.modified, is_new: edit.action === 'create', title: `${title}`, source: 'qucoder' })
  }
  async function saveAll() {
    if (!workspace) { onError('Open the folder first.'); return }
    setSavingAll(true)
    try {
      for (const edit of good) {
        if (inHistory(edit)) continue
        await api.changeSave({ workspace_id: workspace.id, path: edit.path, title, source: 'qucoder', content: edit.modified, is_new: edit.action === 'create' })
        setSaved(current => ({ ...current, [edit.path]: true }))
      }
      onSaved?.()
    } catch (err) { onError(err.message) } finally { setSavingAll(false) }
  }

  return <div className="flex gap-3">
    <span className="qa-avatar qa-avatar-bot" aria-hidden="true">Q</span>
    <div className="qa-bubble-bot">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-xs font-semibold">QuCoder</span>
        {message.status === 'streaming' && <span className="text-[11px] text-sky-400 flex items-center gap-1.5"><LoaderCircle size={11} className="animate-spin" />{message.stage || 'Working…'}</span>}
      </div>
      {message.content ? <QAMarkdown text={shown} paths={[]} /> : message.status === 'streaming' && <p className="text-sm text-muted">Reading your files…</p>}
      {message.status === 'streaming' && message.content && <span className="qa-caret" aria-hidden="true" />}
      {NOTE[message.status] && <p className="text-[11px] text-amber mt-3 flex gap-1.5"><AlertTriangle size={12} className="shrink-0 mt-0.5" />{NOTE[message.status]}</p>}
      {message.status === 'error' && <p className="error-box mt-3 !text-xs">{message.error || 'QuCoder failed.'}</p>}

      {edits.length > 0 && <div className="qc-edits">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <p className="eyebrow flex items-center gap-2"><GitCommitHorizontal size={13} />Proposed changes · {good.length} file{good.length === 1 ? '' : 's'}</p>
          {good.some(e => !inHistory(e)) && <button type="button" className="btn-small" onClick={saveAll} disabled={savingAll}>
            {savingAll ? <LoaderCircle size={13} className="animate-spin" /> : <Save size={13} />}Save all as changes</button>}
        </div>
        <ul className="space-y-2">{edits.map((edit, i) => <li key={`${edit.path}-${i}`} className={`qc-edit ${edit.ok ? '' : 'qc-edit-bad'}`}>
          <span className="qc-edit-icon">{edit.action === 'create' ? <FilePlus2 size={15} /> : <FileCode2 size={15} />}</span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-medium break-all">{edit.path || 'Change blocks'}</p>
            <p className="text-[11px] text-muted mt-0.5">{edit.ok ? <>{edit.action === 'create' ? 'New file' : 'Modified'} · <b className="chg-add">+{edit.stats?.added}</b> <b className="chg-del">−{edit.stats?.removed}</b>{inHistory(edit) ? ' · in change history' : ''}</> : 'Could not be applied'}</p>
            {edit.written_as && <p className="text-[11px] text-muted mt-0.5">QuCoder wrote <code>{edit.written_as}</code>; matched to this file.</p>}
            {edit.save_error && <p className="text-[11px] text-amber mt-1">{edit.save_error}</p>}
            {edit.errors?.map((e, j) => <p key={j} className="text-[11px] text-amber mt-1">{e}</p>)}
          </div>
          {edit.ok && <button type="button" className="btn-small shrink-0" onClick={() => review(edit)}>Review diff</button>}
        </li>)}</ul>
        <p className="text-[11px] text-muted mt-3">{good.length > 0 && good.every(inHistory) ? 'Saved to the change history. ' : ''}Nothing has been written to your folder. Review a diff to edit, download, replace or revert it.</p>
      </div>}

      {(usage || m) && <div className="qa-metrics">
        {usage && <span className="text-fg/85">{fmt(usage.input_tokens)} in · {fmt(usage.output_tokens)} out{m?.cost ? ` · ${usd(m.cost.complete ? m.cost.total_usd : m.cost.known_subtotal_usd)}` : ''}{m?.duration_ms ? ` · ${(m.duration_ms / 1000).toFixed(1)}s` : ''}</span>}
      </div>}
    </div>
  </div>
}
