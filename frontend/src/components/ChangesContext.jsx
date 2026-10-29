import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import BrandLoader from './BrandLoader.jsx'

// The change review (Monaco diff, history, save / download / replace / revert) is loaded on first use.
const ChangeReview = lazy(() => import('./ChangeReview.jsx'))
const Context = createContext(null)
const NONE = { workspace: null, count: 0, busy: false, refresh() {}, openDraft: async () => false, openChange() {}, openHistory() {}, openQuCoder() {} }

// Any tab can call useChanges().openDraft({ path, title, source, edits | content, is_new }).
export const useChanges = () => useContext(Context) || NONE

export function ChangesProvider({ workspace, light, onError, onOpenQuCoder, children }) {
  const [modal, setModal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(0)
  const refresh = useCallback(() => {
    api.changesList(workspace?.root ? { root: workspace.root } : {}).then(items => setCount(items.length)).catch(() => {})
  }, [workspace?.root])
  useEffect(() => { refresh() }, [refresh])

  const openDraft = useCallback(async request => {
    if (!workspace) { onError('Open the codebase folder first, so the change can be applied to its files.'); return false }
    setBusy(true)
    try {
      const draft = await api.changeDraft({ workspace_id: workspace.id, path: request.path, edits: request.edits, content: request.content, is_new: Boolean(request.is_new) })
      setModal({ mode: 'draft', draft, request })
      return true
    } catch (err) {
      onError(err.message)
      return false
    } finally {
      setBusy(false)
    }
  }, [workspace, onError])

  const value = useMemo(() => ({
    workspace, count, busy, openDraft, refresh, openQuCoder: seed => onOpenQuCoder?.(seed),
    openChange: id => setModal({ mode: 'change', changeId: id }), openHistory: () => setModal({ mode: 'history' }),
  }), [workspace, count, busy, openDraft, refresh, onOpenQuCoder])

  return <Context.Provider value={value}>
    {children}
    {modal && <Suspense fallback={<div className="chg-backdrop"><BrandLoader className="text-white" label="Loading the editor…" /></div>}>
      <ChangeReview modal={modal} workspace={workspace} light={light} onError={onError} onChanged={refresh} onClose={() => { setModal(null); refresh() }} />
    </Suspense>}
  </Context.Provider>
}
