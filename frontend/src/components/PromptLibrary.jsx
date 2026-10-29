import { useState } from 'react'
import { BookOpen, Check, Plus, Save, Trash2 } from 'lucide-react'
import { api } from '../api.js'

export default function PromptLibrary({ prompts, setPrompts, selectedId, onSelect, onReview }) {
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState({ name: '', content: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [deletePending, setDeletePending] = useState(false)
  function edit(prompt) {
    setEditingId(prompt?.id || null)
    setDraft({ name: prompt?.name || '', content: prompt?.content || '' })
    setError(''); setMessage(''); setDeletePending(false)
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const saved = await api.savePrompt(editingId, draft)
      setPrompts(items => [...items.filter(item => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)))
      setEditingId(saved.id); setDraft({ name: saved.name, content: saved.content })
      if (!selectedId) onSelect(saved.id)
      setMessage('Prompt saved. Select it below to use it for a review.')
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true); setError('')
    try {
      await api.deletePrompt(editingId)
      setPrompts(items => items.filter(item => item.id !== editingId))
      if (selectedId === editingId) onSelect('')
      edit(null)
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <section className="max-w-6xl mx-auto p-6 lg:p-10">
    <div className="flex items-center justify-between gap-4 mb-7"><div><p className="eyebrow">Your review criteria</p><h1 className="page-title">Prompt library</h1><p className="text-muted text-sm mt-2">Save your standards. Choose exactly one prompt for each run.</p></div><button className="btn" onClick={() => edit(null)} disabled={busy}><Plus size={16} />New prompt</button></div>
    <div className="grid lg:grid-cols-[1fr_1.2fr] gap-6">
      <div className="space-y-3">
        {prompts.map(prompt => <article key={prompt.id} className={`card p-5 ${selectedId === prompt.id ? 'border-accent' : ''}`}>
          <div className="flex items-start gap-3"><input type="radio" name="review-prompt" id={`prompt-${prompt.id}`} checked={selectedId === prompt.id} onChange={() => onSelect(prompt.id)} className="mt-1" />
            <div className="min-w-0 flex-1"><label htmlFor={`prompt-${prompt.id}`} className="font-semibold cursor-pointer">{prompt.name}</label><p className="text-sm text-muted mt-2 line-clamp-3 whitespace-pre-wrap wrap-break-word">{prompt.content}</p></div></div>
          <div className="mt-4 flex justify-between items-center"><span className="text-xs text-sky-400">{selectedId === prompt.id ? 'Selected for next run' : ''}</span><button className="btn-small" onClick={() => edit(prompt)} disabled={busy}>Edit prompt</button></div>
        </article>)}
        {!prompts.length && <div className="card p-8 text-muted"><BookOpen className="mb-3" />Create your first review prompt.</div>}
        <button className="btn w-full" disabled={!selectedId} onClick={onReview}><Check size={15} />Use selected prompt</button>
      </div>
      <form onSubmit={save} className="card p-6 h-fit">
        <h2 className="text-lg font-semibold">{editingId ? 'Edit saved prompt' : 'Create a prompt'}</h2>
        <p className="text-sm text-muted mt-1 mb-5">Describe what to assess and how to present it. Specify exact table headers, column order, sections, or another text format; QuCoRe renders the model’s report without a fixed template.</p>
        <label className="field-label" htmlFor="prompt-name">Prompt name</label>
        <input id="prompt-name" required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Python API reliability" className="input mb-5" />
        <label className="field-label" htmlFor="prompt-content">Review instructions</label>
        <textarea id="prompt-content" required maxLength={24000} rows={15} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} placeholder="Review error handling, resource cleanup, and concurrent access. Cite concrete defects, explain their impact, and recommend focused fixes. Recognize sound implementation choices." className="input leading-relaxed resize-y" />
        <div className="flex justify-between text-xs text-muted mt-2"><span>Saved changes apply to future runs.</span><span>{draft.content.length.toLocaleString()} / 24,000</span></div>
        {error && <p role="alert" className="error-box mt-4">{error}</p>}{message && <p role="status" className="text-added text-sm mt-4">{message}</p>}
        <div className="flex justify-between items-center mt-6 gap-3"><button className="btn-primary" disabled={busy || !draft.name.trim() || !draft.content.trim()}><Save size={15} />{busy ? 'Saving…' : 'Save prompt'}</button>
          {editingId && <button type="button" className="btn text-removed" disabled={busy} onClick={() => setDeletePending(!deletePending)}><Trash2 size={15} />Delete</button>}</div>
        {deletePending && <div className="mt-4 border border-removed/40 rounded-lg p-4 text-sm"><p>Delete this saved prompt? Existing reports keep their prompt snapshot.</p><div className="flex gap-3 mt-3"><button type="button" className="btn text-removed" disabled={busy} onClick={remove}>Delete prompt</button><button type="button" className="btn" onClick={() => setDeletePending(false)}>Keep</button></div></div>}
      </form>
    </div>
  </section>
}
