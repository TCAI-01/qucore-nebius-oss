// The tabs the backend last reported (QUCORE_TABS, QUCORE_GITHUB_IMPORT),
// remembered in this browser, so the header and home page show the same tools while the backend is starting or is
// not running (npm run dev alone). Before the backend has ever answered: the four-tool layout.
const KEY = 'qucore-ui'
export const DEFAULT_UI = { tabs: ['review', 'coder', 'qa', 'quscan'], github_import: true }

export function lastUi() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null')
    return value && typeof value === 'object' && Array.isArray(value.tabs) ? value : DEFAULT_UI
  } catch {
    return DEFAULT_UI
  }
}

export function rememberUi(ui) {
  if (!ui || typeof ui !== 'object') return
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: Array.isArray(ui.tabs) ? ui.tabs : [],
      github_import: ui.github_import !== false }))
  } catch { /* storage unavailable: the default applies next time */ }
}
