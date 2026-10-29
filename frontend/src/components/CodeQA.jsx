import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Bot, ChevronDown, ChevronRight, FileCode2, FolderTree, GitBranch, History, ImagePlus, Info,
  KeyRound, Layers, LoaderCircle, MessageSquarePlus, MessagesSquare, Paperclip, Search, Send, Square, Trash2, User, X,
} from 'lucide-react'
import TabTitle from './TabTitle.jsx'
import { api, qaAsk } from '../api.js'
import FileTree, { Checkbox, collectFiles } from './FileTree.jsx'
import WorkspacePicker from './WorkspacePicker.jsx'
import QAMarkdown from './QAMarkdown.jsx'
import QACodeModal from './QACodeModal.jsx'

const METHODS = [
  { id: 'default', label: 'Default', title: 'Full code', icon: FileCode2,
    text: 'Every file in scope goes straight into the prompt with its name and line numbers.' },
  { id: 'hybrid', label: 'Hybrid RAG', title: 'Top 10 files', icon: Search,
    text: '60% semantic + 40% BM25 keyword search; the 10 most relevant files are sent in full.' },
  { id: 'cursor', label: 'Cursor-style', title: 'Merkle + snippets', icon: GitBranch,
    text: 'Merkle-synced index of functions and classes; the best snippets are sent with file outlines.' },
]
const METHOD_LABEL = Object.fromEntries(METHODS.map(m => [m.id, `${m.label} · ${m.title}`]))
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const SUGGESTIONS = [
  'Give me an architecture overview of this codebase: entry points, main modules and how data flows.',
  'Where is the main entry point, and what happens step by step when a request comes in?',
  'Which parts of this code look most error-prone, and why?',
]

const fmt = value => Number(value || 0).toLocaleString()
const usd = value => (value == null ? 'not priced' : `$${Number(value).toFixed(value >= 1 ? 2 : 4)}`)
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
const seconds = ms => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`)

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ id: uid(), name: file.name || 'pasted-image', media_type: file.type, data: url.split(',')[1] || '', url, size: file.size })
    }
    reader.onerror = () => reject(new Error('The image could not be read.'))
    reader.readAsDataURL(file)
  })
}

// Messages from the backend (history) -> UI messages.
function fromStored(items) {
  return items.map(item => item.role === 'user'
    ? { key: item.id, id: item.id, role: 'user', content: item.content, imageCount: item.data?.images || 0, images: [] }
    : { key: item.id, id: item.id, role: 'assistant', method: item.method, methodLabel: item.data?.method_label || METHOD_LABEL[item.method],
        content: item.content, status: item.status === 'streaming' ? 'error' : item.status,
        error: item.status === 'streaming' ? 'This answer was interrupted (backend restart).' : item.data?.error,
        references: item.data?.references || [], metrics: item.data?.metrics || null,
        estimate: item.data?.metrics?.estimate || null, stage: '' })
}

export default function CodeQA({ workspace, onWorkspace, settings, onError, onConfigure }) {
  const [scope, setScope] = useState('all')
  const [selected, setSelected] = useState(new Set())
  // single select; the first method comes from QUCORE_QA_DEFAULT_METHOD (default: Cursor-style)
  const [method, setMethod] = useState(() => settings?.ui?.qa_default_method || 'default')
  const [advanced, setAdvanced] = useState(false)  // the other methods sit under "Advanced"
  const tucked = true
  const [includeHistory, setIncludeHistory] = useState(true)
  const historyTurns = settings?.ui?.qa_history_turns ?? 5  // QUCORE_QA_HISTORY_TURNS in backend/.env
  const [estimate, setEstimate] = useState(null)
  const [estimating, setEstimating] = useState(false)
  const [estimateError, setEstimateError] = useState('')
  const [showEstimate, setShowEstimate] = useState(true)
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [question, setQuestion] = useState('')  // debounced draft for estimates
  const [images, setImages] = useState([])
  const [dragging, setDragging] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [modal, setModal] = useState(null)
  const scroller = useRef(null)
  const stick = useRef(true)
  const fileInput = useRef(null)
  const input = useRef(null)
  const live = useRef({ streamId: null, controller: null, stopAll: false })
  const pending = useRef({})
  const flushTimer = useRef(null)

  const files = useMemo(() => (workspace ? collectFiles(workspace.tree) : []), [workspace])
  const fileSet = useMemo(() => new Set(files), [files])
  const chosen = [method]
  const scopeFiles = scope === 'all' ? [] : [...selected]
  const scopeReady = Boolean(workspace) && (scope === 'all' ? files.length > 0 : selected.size > 0)

  useEffect(() => { api.qaSessions().then(setSessions).catch(() => {}) }, [])
  // A (re)opened folder keeps every picked file that still exists in it, so re-opening the
  // same folder never loses the selection. Only files missing from the new folder drop out.
  useEffect(() => {
    setSelected(current => {
      if (!current.size) return current
      const kept = new Set([...current].filter(path => fileSet.has(path)))
      return kept.size === current.size ? current : kept
    })
  }, [workspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => setQuestion(draft), 700); return () => clearTimeout(t) }, [draft])
  useEffect(() => {  // grow the question box with its content (up to ~9 lines)
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft])

  // Before-run estimate for every checked method.
  useEffect(() => {
    setEstimateError('')
    if (!scopeReady || !chosen.length) { setEstimate(null); setEstimating(false); return undefined }
    const controller = new AbortController()
    setEstimating(true)
    const timer = setTimeout(async () => {
      try {
        const result = await api.qaPreview({ workspace_id: workspace.id, files: scopeFiles, methods: chosen,
          question, image_count: images.length, session_id: sessionId, include_history: includeHistory }, controller.signal)
        if (!controller.signal.aborted) setEstimate(result)
      } catch (err) {
        if (!controller.signal.aborted) { setEstimate(null); setEstimateError(err.message) }
      } finally {
        if (!controller.signal.aborted) setEstimating(false)
      }
    }, 400)
    return () => { clearTimeout(timer); controller.abort() }
  }, [workspace?.id, scope, selected, method, question, images.length, sessionId, includeHistory, settings]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the view pinned to the newest text while the user is at the bottom.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const update = useCallback((key, patch) => {
    setMessages(items => items.map(m => (m.key === key ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)))
  }, [])

  // Streaming deltas are batched (~25 fps) so long answers render smoothly.
  const flush = useCallback(() => {
    clearTimeout(flushTimer.current)
    flushTimer.current = null
    const chunks = pending.current
    pending.current = {}
    if (!Object.keys(chunks).length) return
    setMessages(items => items.map(m => (chunks[m.key] ? { ...m, content: m.content + chunks[m.key] } : m)))
  }, [])
  const appendDelta = useCallback((key, value) => {
    pending.current[key] = (pending.current[key] || '') + value
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, 40)
  }, [flush])

  async function addImages(list) {
    const incoming = [...list].filter(file => file && file.type?.startsWith('image/'))
    if (!incoming.length) return false
    const problems = []
    const accepted = []
    for (const file of incoming) {
      if (!IMAGE_TYPES.includes(file.type)) { problems.push(`${file.name || 'image'}: use PNG, JPEG, GIF or WebP`); continue }
      if (file.size > MAX_IMAGE_BYTES) { problems.push(`${file.name || 'image'}: larger than 5 MB`); continue }
      accepted.push(file)
    }
    const room = MAX_IMAGES - images.length
    if (accepted.length > room) problems.push(`Up to ${MAX_IMAGES} images per question`)
    try {
      const read = await Promise.all(accepted.slice(0, Math.max(0, room)).map(readImage))
      setImages(current => [...current, ...read].slice(0, MAX_IMAGES))
    } catch (err) { problems.push(err.message) }
    if (problems.length) onError(problems.join('. '))
    return true
  }

  function onPaste(event) {
    const items = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    if (!items.length) return  // plain text paste continues as normal
    event.preventDefault()
    addImages(items.map(item => item.getAsFile()).filter(Boolean))
  }

  function newChat() {
    if (streaming) return
    setSessionId(null)
    setMessages([])
    setDraft('')
    setImages([])
    input.current?.focus()
  }

  async function openSession(id) {
    if (streaming) return
    try {
      const data = await api.qaSession(id)
      setSessionId(id)
      setMessages(fromStored(data.messages))
      stick.current = true
      // Restore this chat's scope and picked files (from its latest question).
      const last = [...data.messages].reverse().find(item => item.role === 'user' && item.data)
      if (last) {
        const saved = (last.data.files || []).filter(path => fileSet.has(path))
        if (saved.length) {
          setScope('selected')
          setSelected(new Set(saved))
        } else if (last.data.scope === 'all') {
          setScope('all')
        }
      }
    } catch (err) { onError(err.message) }
  }

  async function removeSession(id) {
    try {
      await api.qaDeleteSession(id)
      setSessions(items => items.filter(item => item.id !== id))
      if (sessionId === id) newChat()
    } catch (err) { onError(err.message) }
  }

  async function stop() {
    live.current.stopAll = true
    setStopping(true)
    const { streamId, controller } = live.current
    try { if (streamId) await api.qaStop(streamId) } catch { /* the abort below still ends it */ }
    // The server ends the stream with a "stopped" result; abort only if it does not.
    setTimeout(() => { if (live.current.controller === controller) controller?.abort() }, 5000)
  }

  async function send(text = draft) {
    const content = text.trim()
    if (!content || streaming || !scopeReady || !chosen.length || !settings?.configured) return
    const attached = images
    setDraft('')
    setQuestion('')
    setImages([])
    stick.current = true
    setStreaming(true)
    setStopping(false)
    live.current = { streamId: null, controller: null, stopAll: false }
    setMessages(items => [...items, { key: uid(), role: 'user', content, images: attached.map(i => ({ url: i.url, name: i.name })), imageCount: attached.length }])
    let sid = sessionId
    let qid = null
    for (const method of chosen) {
      if (live.current.stopAll) break
      const key = uid()
      setMessages(items => [...items, { key, role: 'assistant', method, methodLabel: METHOD_LABEL[method], content: '',
        status: 'streaming', stage: 'Starting…', references: [], metrics: null, estimate: estimate?.methods?.[method] || null }])
      const controller = new AbortController()
      live.current.controller = controller
      try {
        await qaAsk({
          workspace_id: workspace.id, files: scopeFiles, method, question: content,
          images: attached.map(({ name, media_type, data }) => ({ name, media_type, data })), session_id: sid, question_id: qid,
          include_history: includeHistory,
        }, (event, data) => {
          if (event === 'meta') {
            sid = data.session.id
            qid = data.question_id
            live.current.streamId = data.stream_id
            setSessionId(data.session.id)
            setSessions(items => [data.session, ...items.filter(item => item.id !== data.session.id)])
            update(key, { id: data.message_id, estimate: data.estimate, deployment: data.deployment })
            if (live.current.stopAll) api.qaStop(data.stream_id).catch(() => {})
          } else if (event === 'status') update(key, { stage: data.stage })
          else if (event === 'context') update(key, { references: data.references, contextStats: data.context, retrieval: data.retrieval, index: data.index })
          else if (event === 'delta') appendDelta(key, data.text)
          else if (event === 'usage') update(key, m => ({ liveUsage: data.usage, metrics: m.metrics }))
          else if (event === 'done') {
            flush()
            update(key, { status: data.status, error: data.error, references: data.references, metrics: data.metrics, stage: '' })
          } else if (event === 'error') {
            flush()
            update(key, { status: 'error', error: data.message, stage: '' })
          }
        }, controller.signal)
        flush()
        update(key, m => (m.status === 'streaming' ? { status: 'error', error: 'The answer stream ended unexpectedly.', stage: '' } : {}))
      } catch (err) {
        flush()
        if (err.name === 'AbortError') update(key, { status: 'stopped', stage: '' })
        else update(key, { status: 'error', error: err.message, stage: '' })
      } finally {
        live.current.controller = null
        live.current.streamId = null
      }
    }
    setStreaming(false)
    setStopping(false)
    api.qaSessions().then(setSessions).catch(() => {})
  }

  const selectPaths = (paths, enabled) => setSelected(current => {
    const next = new Set(current)
    paths.forEach(path => (enabled ? next.add(path) : next.delete(path)))
    return next
  })
  const openReference = (ref, focus) => setModal({
    path: ref.path,
    cited: focus ? [focus] : (ref.cited_ranges || []),
    context: focus ? [] : (ref.ranges || []),
  })

  const blocked = chosen.some(id => estimate?.methods?.[id] && !estimate.methods[id].can_run)
  const canSend = Boolean(draft.trim()) && scopeReady && chosen.length > 0 && settings?.configured && !streaming

  return <div className="grid lg:grid-cols-[280px_minmax(0,1fr)_300px] xl:grid-cols-[300px_minmax(0,1fr)_330px] lg:h-[calc(100vh-97px)]">
    <aside className="bg-panel border-r border-line flex flex-col min-w-0 lg:overflow-y-auto">
      <div className="shrink-0">
        <WorkspacePicker workspace={workspace} onWorkspace={onWorkspace} onError={onError} label="01 / Codebase" />
      </div>
      {workspace && <div className="px-5 py-4 border-b border-line shrink-0">
        <p className="eyebrow mb-3">02 / Scope</p>
        <div className="grid grid-cols-2 gap-1 bg-ink border border-line p-1 rounded-lg" role="radiogroup" aria-label="Question scope">
          {[['all', `Entire codebase`, `${fmt(files.length)} files`], ['selected', 'Selected files', `${fmt(selected.size)} selected`]].map(([id, label, note]) =>
            <button key={id} type="button" role="radio" aria-checked={scope === id} onClick={() => setScope(id)}
              className={`rounded-md px-2 py-2 text-left ${scope === id ? 'bg-elevated shadow-xs' : 'text-muted'}`}>
              <span className="block text-xs font-medium">{label}</span><span className="block text-[10px] text-muted">{note}</span>
            </button>)}
        </div>
        {scope === 'selected' && <label className="flex items-center gap-2 text-xs text-muted mt-3">
          <Checkbox checked={files.length > 0 && selected.size === files.length} mixed={selected.size > 0 && selected.size < files.length}
            disabled={!files.length} onChange={() => selectPaths(files, selected.size !== files.length)} />
          Select all eligible files <span className="ml-auto">{files.length}</span>
        </label>}
      </div>}
      {/* The file list takes all remaining height. */}
      {workspace && scope === 'selected' && <div className="flex-1 min-h-[320px] overflow-auto border-b border-line">
        <FileTree tree={workspace.tree} selected={selected} selectPaths={selectPaths} activePath={null}
          onOpen={path => selectPaths([path], !selected.has(path))} />
      </div>}
      <div className="p-5 mt-auto shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="eyebrow flex gap-2 items-center"><History size={13} />Chats</h2>
          <button type="button" className="btn-small" onClick={newChat} disabled={streaming}><MessageSquarePlus size={13} />New chat</button>
        </div>
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {sessions.map(item => <div key={item.id} className={`group flex items-start gap-1 rounded-lg hover:bg-elevated ${sessionId === item.id ? 'bg-elevated' : ''}`}>
            <button type="button" onClick={() => openSession(item.id)} disabled={streaming} className="flex-1 min-w-0 text-left p-3">
              <span className="block truncate text-xs font-medium">{item.title}</span>
              <span className="block text-[10px] text-muted mt-1">{new Date(item.updated_at).toLocaleDateString()} · {item.workspace_name}{item.questions ? ` · ${item.questions} question${item.questions === 1 ? '' : 's'}` : ''}</span>
            </button>
            <button type="button" className="btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100 mt-1.5 mr-1" title="Delete chat"
              aria-label="Delete chat" disabled={streaming} onClick={() => removeSession(item.id)}><Trash2 size={13} /></button>
          </div>)}
          {!sessions.length && <p className="text-xs text-muted">Your chats are saved here.</p>}
        </div>
      </div>
    </aside>

    <main className="flex flex-col min-w-0 min-h-[640px] lg:min-h-0 lg:order-0 order-last">
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-4 lg:px-8 py-6"
        onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {!messages.length ? <EmptyChat ready={scopeReady} configured={settings?.configured} onConfigure={onConfigure}
          onAsk={value => { setDraft(value); input.current?.focus() }} /> :
          <div className="max-w-5xl mx-auto space-y-6">
            {messages.map(m => m.role === 'user'
              ? <UserBubble key={m.key} message={m} />
              : <BotBubble key={m.key} message={m} onOpen={openReference} />)}
          </div>}
      </div>

      <div className={`border-t border-line bg-panel px-4 lg:px-8 py-4 ${dragging ? 'qa-drop' : ''}`}
        onDragOver={event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); setDragging(true) } }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); addImages(event.dataTransfer.files) }}>
        <div className="max-w-5xl mx-auto">
          {images.length > 0 && <div className="flex flex-wrap gap-2 mb-3">
            {images.map(image => <div key={image.id} className="qa-thumb">
              <img src={image.url} alt={image.name} />
              <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages(items => items.filter(i => i.id !== image.id))}><X size={12} /></button>
            </div>)}
          </div>}
          <div className="qa-composer">
            <button type="button" className="btn-icon self-end" title="Attach images (or paste with Ctrl+V)" aria-label="Attach images"
              disabled={streaming || images.length >= MAX_IMAGES} onClick={() => fileInput.current?.click()}><ImagePlus size={18} /></button>
            <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} multiple className="hidden"
              onChange={event => { addImages(event.target.files); event.target.value = '' }} />
            <textarea ref={input} rows={1} value={draft} onChange={event => setDraft(event.target.value)} onPaste={onPaste}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }}
              placeholder={workspace ? 'Ask about the code… (Enter to send, Shift+Enter for a new line, Ctrl+V to paste a screenshot)' : 'Open a codebase folder first'}
              className="qa-input" aria-label="Your question" disabled={!workspace} />
            {streaming
              ? <button type="button" className="btn-primary self-end" onClick={stop} disabled={stopping}>
                {stopping ? <LoaderCircle size={16} className="animate-spin" /> : <Square size={15} />}{stopping ? 'Stopping…' : 'Stop'}
              </button>
              : <button type="button" className="btn-primary self-end" onClick={() => send()} disabled={!canSend}><Send size={15} />Ask</button>}
          </div>
          <div className="flex flex-wrap justify-between gap-2 mt-2 text-[11px] text-muted">
            <span className="flex items-center gap-1.5"><Paperclip size={11} />{images.length ? `${images.length} image${images.length === 1 ? '' : 's'} attached` : 'Paste, drop or attach up to 6 images (PNG, JPEG, GIF, WebP, 5 MB each)'}</span>
            <span>{METHOD_LABEL[method]}{includeHistory ? ' · with chat history' : ''}
              {scopeReady ? ` · ${scope === 'all' ? `entire codebase (${fmt(files.length)} files)` : `${fmt(selected.size)} selected file${selected.size === 1 ? '' : 's'}`}` : ''}</span>
          </div>
          {blocked && !streaming && <p className="text-[11px] text-amber mt-2 flex gap-1.5"><AlertTriangle size={12} className="shrink-0 mt-0.5" />
            The Default method does not fit this scope in the context window. Select fewer files or choose Hybrid RAG / Cursor-style.</p>}
          {!settings?.configured && <button type="button" className="text-xs text-amber mt-2 flex items-center gap-2" onClick={onConfigure}>
            <KeyRound size={13} />Add the endpoint, API key and deployment for {settings?.active?.label || 'the active provider'}.</button>}
        </div>
      </div>
    </main>

    <aside className="bg-panel border-l border-line flex flex-col min-w-0 lg:overflow-y-auto" aria-label="Answer settings">
      <div className="px-5 pt-5 pb-4 border-b border-line">
        <p className="eyebrow">Ask your codebase</p>
        <TabTitle icon={MessagesSquare} name="QuBot" tone="sky" />
      </div>
      <div className="px-5 py-4 border-b border-line">
        <p className="eyebrow mb-3">03 / Method</p>
        <div className="space-y-2" role="radiogroup" aria-label="Answer method">
          {METHODS.filter(m => !tucked || advanced || m.id === (settings?.ui?.qa_default_method || 'cursor') || m.id === method).map(m => {
            const on = method === m.id
            const Icon = m.icon
            return <label key={m.id} className={`qa-method ${on ? 'qa-method-on' : ''}`}>
              <input type="radio" name="qa-method" value={m.id} checked={on} disabled={streaming}
                onChange={() => setMethod(m.id)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold"><Icon size={13} className="text-sky-400" />{m.label}<span className="font-normal text-muted">· {m.title}</span></span>
                <span className="block text-[11px] text-muted leading-snug mt-1">{m.text}</span>
              </span>
            </label>
          })}
          {tucked && <button type="button" className="btn-small px-0! text-sky-400" onClick={() => setAdvanced(!advanced)}>
            {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{advanced ? 'Hide other methods' : 'Advanced: other methods'}
          </button>}
        </div>
      </div>
      <div className="px-5 py-4 border-b border-line space-y-2">
        <p className="eyebrow mb-1">04 / Options</p>
        <label className={`qa-method ${includeHistory ? 'qa-method-on' : ''}`}>
          <input type="checkbox" checked={includeHistory} disabled={streaming}
            onChange={e => setIncludeHistory(e.target.checked)} className="mt-0.5" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-xs font-semibold"><History size={13} className="text-sky-400" />Include history</span>
            <span className="block text-[11px] text-muted leading-snug mt-1">
              Sends the previous {historyTurns} answer{historyTurns === 1 ? '' : 's'} of this chat with your question, so follow-ups keep their context.
            </span>
          </span>
        </label>
      </div>
      <div className="px-5 py-4">
        <EstimatePanel estimate={estimate} busy={estimating} error={estimateError} method={method} open={showEstimate}
          onToggle={() => setShowEstimate(!showEstimate)} />
      </div>
    </aside>
    {modal && <QACodeModal workspaceId={workspace?.id} target={modal} onClose={() => setModal(null)} />}
  </div>
}

function EstimatePanel({ estimate, busy, error, method, open, onToggle }) {
  const row = estimate?.methods?.[method]
  const items = row ? [
    ['Files in scope', fmt(row.files)],
    ['Lines in scope', fmt(row.lines)],
    ['Source tokens', `~${fmt(estimate.source_tokens)}`],
    ['Input tokens', row.input_tokens_low !== row.input_tokens ? `${fmt(row.input_tokens_low)} – ${fmt(row.input_tokens)}` : fmt(row.input_tokens)],
    ['Output tokens (max)', fmt(row.max_output_tokens)],
    ['Embedding tokens', row.method === 'default' ? '—' : estimate.semantic_available
      ? `${fmt(row.embedding_tokens)}${row.files_to_index ? ` (${fmt(row.files_to_index)} files to index)` : ''}` : 'BM25 only'],
  ] : []
  return <div className="rounded-lg border border-line bg-ink/40">
    <button type="button" className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs" onClick={onToggle} aria-expanded={open}>
      <span className="flex items-center gap-2 font-medium">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Before you ask: estimate</span>
      {busy && <LoaderCircle size={12} className="animate-spin text-muted" />}
    </button>
    {open && <div className="px-3 pb-3">
      {error && <p className="text-xs text-removed">{error}</p>}
      {!row && !error && <p className="text-xs text-muted">Open a folder and choose a scope to see lines, tokens and cost.</p>}
      {row && <>
        <dl className="text-[11px] divide-y divide-line/60">
          {items.map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-1.5">
            <dt className="text-muted">{label}</dt><dd className="text-right tabular-nums">{value}</dd>
          </div>)}
        </dl>
        <div className={`mt-2 rounded-md p-2.5 flex justify-between items-baseline ${row.can_run ? 'bg-elevated/60' : 'bg-removed/10 text-removed'}`}>
          <span className="text-[11px] text-muted">Cost (max)</span>
          <span className="text-base font-semibold tabular-nums">{usd(row.cost.total_max_usd)}{row.cost.complete ? '' : '*'}</span>
        </div>
        {row.problem && <p className="text-[11px] text-removed mt-2">{row.problem}</p>}
        <p className="text-[10px] text-muted mt-2 leading-relaxed">
          {row.note} Context {fmt(estimate.context_window)} · output reserved {fmt(estimate.max_output_tokens)} · {estimate.token_method}.
          {row.method !== 'default' && (estimate.semantic_available
            ? ` Hybrid weights ${Math.round(estimate.weights.semantic * 100)}% semantic / ${Math.round(estimate.weights.keyword * 100)}% BM25 (${estimate.embedding_deployment}).`
            : ' No embedding deployment: keyword search only.')}
          {' '}Cost uses your rates and the maximum output; * = a rate is not set. Actual usage appears under each answer.
        </p>
      </>}
    </div>}
  </div>
}

function EmptyChat({ ready, configured, onConfigure, onAsk }) {
  return <div className="h-full min-h-[320px] flex flex-col items-center justify-center text-center px-6">
    <div className="rounded-2xl border border-accent/40 bg-accent/10 p-5 mb-5"><Bot size={34} className="text-sky-400" /></div>
    <h2 className="text-xl font-semibold">Ask anything about your code</h2>
    <p className="text-muted max-w-lg text-sm mt-3 leading-relaxed">
      Choose a method on the right. Answers stream in, cite the exact files and lines they use, and every reference opens the code.
    </p>
    {!ready && <p className="text-xs text-amber mt-4 flex items-center gap-2"><FolderTree size={13} />Open a folder and choose the scope first.</p>}
    {!configured && <button type="button" className="text-xs text-amber mt-3 flex items-center gap-2" onClick={onConfigure}><KeyRound size={13} />Configure the model in Credentials.</button>}
    <div className="mt-6 grid gap-2 w-full max-w-xl">
      {SUGGESTIONS.map(text => <button key={text} type="button" className="qa-suggestion" onClick={() => onAsk(text)}>{text}</button>)}
    </div>
  </div>
}

function UserBubble({ message }) {
  return <div className="flex justify-end gap-3">
    <div className="qa-bubble-user">
      {message.images?.length > 0 && <div className="flex flex-wrap gap-2 mb-2">
        {message.images.map((image, i) => <img key={i} src={image.url} alt={image.name} className="qa-bubble-image" />)}
      </div>}
      {!message.images?.length && message.imageCount > 0 && <p className="text-[11px] opacity-80 mb-1 flex items-center gap-1"><ImagePlus size={11} />{message.imageCount} image{message.imageCount === 1 ? '' : 's'} attached</p>}
      <p className="whitespace-pre-wrap wrap-break-word text-sm leading-6">{message.content}</p>
    </div>
    <span className="qa-avatar qa-avatar-user" aria-hidden="true"><User size={15} /></span>
  </div>
}

const STATUS_NOTE = {
  stopped: 'Stopped by you. The partial answer is kept.',
  truncated: 'The answer reached the output limit even after continuing. Ask a follow-up to get the rest.',
  filtered: 'The provider content filter stopped this answer.',
  refused: 'The model declined to answer.',
}

function BotBubble({ message, onOpen }) {
  const [details, setDetails] = useState(false)
  const refs = message.references || []
  const cited = refs.filter(r => r.cited)
  const others = refs.filter(r => !r.cited)
  const paths = refs.map(r => r.path)
  const m = message.metrics
  const usage = m?.usage || message.liveUsage
  const est = message.estimate
  const onCite = cite => {
    const ref = refs.find(r => r.path === cite.path) || { path: cite.path }
    onOpen(ref, cite.start ? { start: cite.start, end: cite.end } : null)
  }
  return <div className="flex gap-3">
    <span className="qa-avatar qa-avatar-bot" aria-hidden="true">Q</span>
    <div className="qa-bubble-bot">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-xs font-semibold">QuCoRe</span>
        <span className="pill">{message.methodLabel}</span>
        {message.status === 'streaming' && <span className="text-[11px] text-sky-400 flex items-center gap-1.5"><LoaderCircle size={11} className="animate-spin" />{message.stage || 'Working…'}</span>}
      </div>
      {message.content
        ? <QAMarkdown text={message.content} paths={paths} onCite={onCite} />
        : message.status === 'streaming' && <p className="text-sm text-muted">Preparing the context…</p>}
      {message.status === 'streaming' && message.content && <span className="qa-caret" aria-hidden="true" />}
      {STATUS_NOTE[message.status] && <p className="text-[11px] text-amber mt-3 flex gap-1.5"><Info size={12} className="shrink-0 mt-0.5" />{STATUS_NOTE[message.status]}</p>}
      {message.status === 'error' && <p className="error-box mt-3 text-xs!">{message.error || 'The answer failed.'}</p>}

      {refs.length > 0 && <div className="mt-4 pt-3 border-t border-line">
        <p className="eyebrow mb-2">Referenced code</p>
        <div className="flex flex-wrap gap-1.5">
          {cited.map(ref => <RefChip key={ref.path} item={ref} cited onOpen={onOpen} />)}
          {others.slice(0, cited.length ? 8 : 12).map(ref => <RefChip key={ref.path} item={ref} onOpen={onOpen} />)}
        </div>
        {others.length > (cited.length ? 8 : 12) && <details className="mt-2">
          <summary className="text-[11px] text-muted cursor-pointer">{others.length - (cited.length ? 8 : 12)} more file(s) in the context</summary>
          <div className="flex flex-wrap gap-1.5 mt-2">{others.slice(cited.length ? 8 : 12).map(ref => <RefChip key={ref.path} item={ref} onOpen={onOpen} />)}</div>
        </details>}
      </div>}

      {(usage || est) && <div className="qa-metrics">
        {est && <span title="Estimated before the answer (maximum output reserved)">Estimated: ~{fmt(est.input_tokens)} in · ≤{fmt(est.max_output_tokens)} out · ≤{usd(est.cost?.total_max_usd)}</span>}
        {usage && <span className="text-fg/85">Actual: {fmt(usage.input_tokens)} in · {fmt(usage.output_tokens)} out
          {usage.embedding_tokens ? ` · ${fmt(usage.embedding_tokens)} embedding` : ''}
          {m ? ` · ${usd(m.total_usd)}${m.complete ? '' : '*'}` : ''}{m?.duration_ms ? ` · ${seconds(m.duration_ms)}` : ''}</span>}
        {m?.context?.files != null && <span>Context: {fmt(m.context.files)} file{m.context.files === 1 ? '' : 's'} · {fmt(m.context.snippets)} snippet{m.context.snippets === 1 ? '' : 's'} · {fmt(m.context.lines)} lines · ~{fmt(m.context.tokens)} tokens</span>}
        {m && (m.retrieval || m.index) && Object.keys(m.retrieval || {}).length > 0 &&
          <button type="button" className="btn-small px-1! py-0!" onClick={() => setDetails(!details)}>{details ? 'Hide' : 'Show'} retrieval details</button>}
      </div>}
      {details && m && <RetrievalDetails metrics={m} onOpen={onOpen} />}
    </div>
  </div>
}

function RefChip({ item, cited, onOpen }) {
  const ranges = (cited ? item.cited_ranges : item.ranges) || []
  const label = ranges.slice(0, 2).map(r => (r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`)).join(', ')
  return <button type="button" className={`qa-ref ${cited ? 'qa-ref-cited' : ''}`} onClick={() => onOpen(item)} title={item.path}>
    <FileCode2 size={12} />
    <span className="font-mono truncate max-w-[260px]">{item.path}</span>
    {label && <span className="text-muted">{label}{ranges.length > 2 ? ` +${ranges.length - 2}` : ''}</span>}
    {item.symbols?.length > 0 && <span className="text-muted truncate max-w-[140px]">· {item.symbols.slice(0, 2).join(', ')}</span>}
  </button>
}

function RetrievalDetails({ metrics, onOpen }) {
  const r = metrics.retrieval || {}
  const index = metrics.index
  return <div className="mt-3 rounded-lg border border-line bg-ink/50 p-3 text-[11px] space-y-2">
    <p>
      {r.semantic === false || r.semantic_disabled ? 'Keyword (BM25) search only - no embedding deployment.'
        : `Hybrid: ${Math.round((r.semantic_weight ?? 0.6) * 100)}% semantic + ${Math.round((r.keyword_weight ?? 0.4) * 100)}% BM25`}
      {r.candidates != null && ` · ${fmt(r.candidates)} candidates from ${fmt(r.chunks_in_scope)} chunks`}
    </p>
    {index && <p>Merkle sync: {index.up_to_date ? 'index already up to date' : `${index.added} new, ${index.changed} changed, ${index.removed} removed file(s); ${fmt(index.embedded_chunks)} chunks embedded, ${fmt(index.reused_chunks)} reused from cache`} · {fmt(index.visited_nodes)} tree nodes compared · root <span className="font-mono">{String(index.root || '').slice(0, 12)}</span></p>}
    {r.top_hits?.length > 0 && <div className="overflow-x-auto">
      <table className="qa-estimate">
        <thead><tr><th>#</th><th>Chunk</th><th>Semantic</th><th>BM25</th><th>Fused</th></tr></thead>
        <tbody>{r.top_hits.map((hit, i) => <tr key={`${hit.path}${hit.start}`}>
          <td>{i + 1}</td>
          <td><button type="button" className="qa-cite" onClick={() => onOpen({ path: hit.path }, { start: hit.start, end: hit.end })}>
            {hit.path}:{hit.start}-{hit.end}</button>{hit.symbol && <span className="text-muted"> {hit.symbol}</span>}</td>
          <td>{hit.semantic?.toFixed(3)}</td><td>{hit.keyword?.toFixed(2)}</td><td>{hit.fused?.toFixed(3)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </div>
}
