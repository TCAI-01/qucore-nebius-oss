import { useEffect, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import './PanelToggle.css'

// Hide or show the side panels of every tab so the middle widens (wide screens only).
// The choice is remembered in this browser. App puts the returned class names on the page root;
// PanelToggle.css hides the first (left) and last (right) <aside class="bg-panel"> of each tab layout.
const KEY = 'qucore-panels'

export function usePanels() {
  const [state, setState] = useState(() => {
    try { return { left: false, right: false, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return { left: false, right: false } }
  })
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* storage off */ } }, [state])
  const toggle = side => setState(current => ({ ...current, [side]: !current[side] }))
  const className = `${state.left ? 'qc-hide-left' : ''} ${state.right ? 'qc-hide-right' : ''}`
  return { hidden: state, toggle, className }
}

export default function PanelToggles({ panels, left, right }) {
  const { hidden, toggle } = panels
  return <>
    {left && <button type="button" className={`qc-edge qc-edge-left ${hidden.left ? 'off' : ''}`} onClick={() => toggle('left')}
      title={hidden.left ? 'Show the left panel' : 'Hide the left panel'} aria-label={hidden.left ? 'Show the left panel' : 'Hide the left panel'}>
      {hidden.left ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
    </button>}
    {right && <button type="button" className={`qc-edge qc-edge-right ${hidden.right ? 'off' : ''}`} onClick={() => toggle('right')}
      title={hidden.right ? 'Show the right panel' : 'Hide the right panel'} aria-label={hidden.right ? 'Show the right panel' : 'Hide the right panel'}>
      {hidden.right ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
    </button>}
  </>
}
