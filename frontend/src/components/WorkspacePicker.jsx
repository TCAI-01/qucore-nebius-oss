import { useEffect, useState } from 'react'
import { FolderOpen, FolderSearch, LoaderCircle, Wand2 } from 'lucide-react'
import { api } from '../api.js'
import GithubImport from './GithubImport.jsx'

// Opens a codebase folder exactly like the Review tab does. The opened workspace
// is shared with the Review tab through App (onWorkspace).
export default function WorkspacePicker({ workspace, onWorkspace, onError, label = 'Codebase', suggestion, suggestionNote }) {
  const [path, setPath] = useState(workspace?.root || '')
  const [opening, setOpening] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  useEffect(() => { if (workspace?.root) setPath(workspace.root) }, [workspace?.root])

  async function open(value) {
    const target = (value ?? path).trim()
    if (!target) return
    setOpening(true)
    try {
      const result = await api.openWorkspace(target)
      setPath(result.root)
      onWorkspace(result)
    } catch (err) {
      onError(err.message)
    } finally {
      setOpening(false)
    }
  }

  // "Browse": native (Windows Explorer) folder dialog; the chosen folder opens straight away.
  async function browse() {
    setBrowsing(true)
    try {
      const picked = await api.pickFolder(path.trim())
      if (picked?.path) {
        setPath(picked.path)
        await open(picked.path)
      }
    } catch (err) {
      onError(err.message)
    } finally {
      setBrowsing(false)
    }
  }

  const showSuggestion = suggestion && suggestion !== workspace?.root
  return <div className="p-5 border-b border-line" data-tour="workspace">
    <p className="eyebrow mb-3">{label}</p>
    <form onSubmit={event => { event.preventDefault(); open() }} className="space-y-3">
      <div className="flex gap-2">
        <input className="input font-mono text-xs" placeholder="Absolute path, or Browse…" value={path}
          onChange={e => setPath(e.target.value)} aria-label="Absolute local codebase path" />
        <button type="button" className="btn shrink-0" onClick={browse} disabled={browsing || opening}
          title="Choose a folder in Windows Explorer">
          {browsing ? <LoaderCircle size={15} className="animate-spin" /> : <FolderSearch size={15} />}Browse
        </button>
      </div>
      <button className="btn w-full" disabled={opening || !path.trim()}>
        {opening ? <LoaderCircle size={15} className="animate-spin" /> : <FolderOpen size={15} />}
        {opening ? 'Scanning…' : workspace ? 'Open another folder' : 'Open folder'}
      </button>
    </form>
    <GithubImport workspace={workspace} onWorkspace={onWorkspace} onError={onError} disabled={opening} />
    {workspace && <p className="field-help truncate" title={workspace.root}>
      Open: <span className="text-fg font-medium">{workspace.name}</span> · {workspace.selectable_count} selectable files
    </p>}
    {showSuggestion && <div className="mt-3 rounded-lg border border-accent/30 bg-accent/10 p-3">
      <p className="text-[11px] text-muted leading-relaxed">{suggestionNote || 'Suggested folder:'}</p>
      <p className="font-mono text-[11px] break-all mt-1">{suggestion}</p>
      <button type="button" className="btn-small px-0! mt-2 text-sky-400" disabled={opening} onClick={() => { setPath(suggestion); open(suggestion) }}>
        <Wand2 size={12} />Open this folder
      </button>
    </div>}
    {!workspace && !showSuggestion && <p className="field-help">A folder on the machine running FastAPI.</p>}
  </div>
}
