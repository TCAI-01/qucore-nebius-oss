import './TabTitle.css'

// Page heading used by every tool tab: a gradient icon badge and the tab's name,
// in the same style as QuScan's and QuCoder's headings.
export default function TabTitle({ icon: Icon, name, tone = 'blue', className = '' }) {
  return <h1 className={`page-title flex items-center gap-3 ${className}`}>
    <span className={`tab-badge tab-badge-${tone}`} aria-hidden="true"><Icon size={20} /></span>{name}
  </h1>
}
