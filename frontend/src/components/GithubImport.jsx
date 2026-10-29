import { useEffect, useState } from 'react'
import { Clock3, ExternalLink, GitBranch, LoaderCircle } from 'lucide-react'
import { api } from '../api.js'
import { lastUi } from '../uiCache.js'

// Opens a public GitHub repository as the workspace. The server downloads the
// commit once, unpacks a private copy for this person and scans it like a folder.
// Downloads unused for QUCORE_GITHUB_IDLE_MINUTES are deleted on the server; the saved repository
// then comes back as a hint (setRepoHint) that fills in the URL, so the person imports it again.
let repoHint = null
export function setRepoHint(value) {
  repoHint = value
  try { window.dispatchEvent(new CustomEvent('qucore-repo-hint', { detail: value })) } catch { /* old browser */ }
}

export default function GithubImport({ workspace, onWorkspace, onError, disabled }) {
  const [url, setUrl] = useState(() => repoHint?.repo || '')
  const [ref, setRef] = useState(() => repoHint?.ref || '')
  const [hint, setHint] = useState(repoHint)
  useEffect(() => {
    const listen = event => {
      setHint(event.detail)
      setUrl(current => current || event.detail?.repo || '')
      setRef(current => current || event.detail?.ref || '')
    }
    window.addEventListener('qucore-repo-hint', listen)
    return () => window.removeEventListener('qucore-repo-hint', listen)
  }, [])
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  if (lastUi().github_import === false) return null  // QUCORE_GITHUB_IMPORT='false'
  const source = workspace?.source?.kind === 'github' ? workspace.source : null

  async function submit(event) {
    event.preventDefault()
    if (!url.trim()) return
    setBusy(true)
    try { onWorkspace(await api.githubWorkspace(url.trim(), ref.trim(), fresh)); setFresh(false); setHint(null); repoHint = null }
    catch (err) { onError(err.message) }
    finally { setBusy(false) }
  }

  return <form onSubmit={submit} className="space-y-2 mt-3">
    <label className="field-label flex items-center gap-1.5" htmlFor="github-url"><GitBranch size={13} />Public GitHub repository</label>
    <div className="flex gap-2">
      <input id="github-url" className="input font-mono text-xs" placeholder="owner/repo or https://github.com/owner/repo"
        value={url} onChange={e => setUrl(e.target.value)} />
      <input className="input font-mono text-xs w-28! shrink-0" placeholder="branch/tag" aria-label="Branch, tag or commit (optional)"
        value={ref} onChange={e => setRef(e.target.value)} />
    </div>
    <label className="flex items-center gap-2 text-[11px] text-muted">
      <input type="checkbox" checked={fresh} onChange={e => setFresh(e.target.checked)} />
      Fresh copy (discards edits applied to an earlier import of the same commit)
    </label>
    {hint && !workspace && url.trim() === hint.repo && <p className="field-help flex items-start gap-1.5 text-amber">
      <Clock3 size={12} className="shrink-0 mt-0.5" />
      The download of {hint.repo} was removed after {hint.minutes || 30} minutes without use. Press Import to fetch it again.</p>}
    <button className="btn w-full" disabled={busy || disabled || !url.trim()}>
      {busy ? <LoaderCircle size={15} className="animate-spin" /> : <GitBranch size={15} />}
      {busy ? 'Downloading…' : 'Import repository'}
    </button>
    {source && <a href={source.url} target="_blank" rel="noreferrer" className="field-help flex items-center gap-1 hover:text-fg">
      <ExternalLink size={11} />{source.repo} @ {source.ref} ({source.sha.slice(0, 7)})
    </a>}
  </form>
}
