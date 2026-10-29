import './BrandLoader.css'

// The one QuCoRe loader: the QuCoRe icon (public/qucore 1 logo.png) in a soft disc with a turning ring.
// size: "lg" (start-up, full screen), "md" (a page or panel), "sm" (inside a card or table).
export default function BrandLoader({ label = '', size = 'md', full = false, className = '', children }) {
  return <div role="status" aria-live="polite" className={`brand-loader brand-loader-${size} ${full ? 'brand-loader-full' : ''} ${className}`}>
    <span className="brand-loader-mark" aria-hidden="true">
      <span className="brand-loader-ring" />
      <img src="/qucore 1 logo.png" alt="" draggable="false" />
    </span>
    {label && <span className="brand-loader-label">{label}</span>}
    {children}
    {!label && <span className="sr-only">Loading</span>}
  </div>
}
