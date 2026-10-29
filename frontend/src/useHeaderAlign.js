import { useEffect } from 'react'

// Header tabs start where the left sidebar ends (the codebase / file panel), so the bar lines up with the
// content below it. Pages without a sidebar (home, Prompts, Credentials, Dashboard) or a collapsed sidebar
// keep the centred bar. If the room left would be too small for the tabs (narrow laptops), the bar moves
// only as far as it still fits. Sets --nav-shift on the header; index.css applies it.
const INSET = 16 // px between the sidebar's edge and the start of the tab bar

function sidebarEnd(header) {
  const below = header.getBoundingClientRect().bottom
  let end = 0
  for (const aside of document.querySelectorAll('aside')) {
    if (!aside.offsetParent && getComputedStyle(aside).position !== 'fixed') continue
    const r = aside.getBoundingClientRect()
    if (r.left <= 1 && r.width >= 150 && r.width <= 600 && Math.abs(r.top - below) <= 4 && r.height > 100) end = Math.max(end, r.right)
  }
  return end
}

function align() {
  const header = document.querySelector('.app-header')
  const nav = header?.querySelector(':scope > nav')
  if (!header || !nav) return
  const end = getComputedStyle(nav).display === 'none' ? 0 : sidebarEnd(header)
  if (!end) { header.style.removeProperty('--nav-shift'); header.removeAttribute('data-nav-aligned'); return }
  // natural (content) width of the bar, and where its grid column starts
  const saved = [nav.style.width, nav.style.maxWidth, nav.style.marginLeft, nav.style.marginRight]
  Object.assign(nav.style, { width: 'max-content', maxWidth: 'none', marginLeft: '0px', marginRight: 'auto' })
  const natural = nav.getBoundingClientRect().width
  const columnLeft = nav.getBoundingClientRect().left
  ;[nav.style.width, nav.style.maxWidth, nav.style.marginLeft, nav.style.marginRight] = saved
  const right = header.lastElementChild.getBoundingClientRect().left - parseFloat(getComputedStyle(header).columnGap || '0')
  const room = right - columnLeft
  const shift = Math.max(0, Math.min(end + INSET - columnLeft, room - natural))
  header.style.setProperty('--nav-shift', `${Math.round(shift)}px`)
  header.setAttribute('data-nav-aligned', '')
}

export default function useHeaderAlign() {
  useEffect(() => {
    let frame = 0
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(align) }
    schedule()
    window.addEventListener('resize', schedule)
    // tab switches, collapsing a side panel: anything that adds, hides or resizes the sidebar
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] })
    const sizes = new ResizeObserver(schedule)
    sizes.observe(document.body)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); mutations.disconnect(); sizes.disconnect() }
  }, [])
}
