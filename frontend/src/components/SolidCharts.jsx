// Dependency-free charts for the Solidify report. Colours come from the app's theme
// variables, so they follow light and dark mode.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
export const SEV_COLOR = { critical: '#e5484d', high: '#f07a3a', medium: '#e0a43a', low: '#3b9bf0', info: '#8b91a7' }

export const scoreColor = score => (score == null ? '#8b91a7' : score >= 80 ? '#3fb978' : score >= 65 ? '#e0a43a' : '#e5484d')

export function ScoreRing({ score, grade, size = 132 }) {
  const stroke = 11
  const radius = (size - stroke - 4) / 2
  const circumference = 2 * Math.PI * radius
  const fraction = Math.max(0, Math.min(100, score ?? 0)) / 100
  const mid = size / 2
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
    aria-label={`Design score ${score ?? 'not available'} out of 100, grade ${grade || 'none'}`}>
    <circle cx={mid} cy={mid} r={radius} fill="none" strokeWidth={stroke} style={{ stroke: 'rgb(var(--elevated))' }} />
    <circle cx={mid} cy={mid} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round"
      strokeDasharray={`${circumference * fraction} ${circumference}`} transform={`rotate(-90 ${mid} ${mid})`}
      style={{ stroke: scoreColor(score) }} />
    <text x={mid} y={mid + 4} textAnchor="middle" fontSize={size * 0.3} fontWeight="700" style={{ fill: 'rgb(var(--fg))' }}>{score ?? '–'}</text>
    <text x={mid} y={mid + size * 0.21} textAnchor="middle" fontSize={size * 0.1} style={{ fill: 'rgb(var(--muted))' }}>grade {grade || '–'}</text>
  </svg>
}

export function Radar({ items }) {
  const n = items.length
  if (n < 3) return <p className="text-xs text-muted">Choose at least three focus areas to draw the radar.</p>
  const W = 360, H = 280, cx = W / 2, cy = H / 2 + 2, R = 90
  const angle = i => -Math.PI / 2 + (2 * Math.PI * i) / n
  const at = (i, f) => [cx + R * f * Math.cos(angle(i)), cy + R * f * Math.sin(angle(i))]
  const ring = f => items.map((_, i) => at(i, f).map(v => v.toFixed(1)).join(',')).join(' ')
  const shape = items.map((it, i) => at(i, Math.max(0.03, (it.value ?? 0) / 100)).map(v => v.toFixed(1)).join(',')).join(' ')
  return <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[440px] mx-auto" role="img" aria-label="Radar chart of the area scores">
    {[0.25, 0.5, 0.75, 1].map(f => <polygon key={f} points={ring(f)} fill="none" strokeWidth="1" style={{ stroke: 'rgb(var(--line))' }} />)}
    {items.map((_, i) => { const [x, y] = at(i, 1); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} strokeWidth="1" style={{ stroke: 'rgb(var(--line))' }} /> })}
    <polygon points={shape} strokeWidth="2" strokeLinejoin="round" style={{ fill: 'rgb(var(--accent) / .28)', stroke: '#3698ef' }} />
    {items.map((it, i) => { const [x, y] = at(i, Math.max(0.03, (it.value ?? 0) / 100)); return <circle key={i} cx={x} cy={y} r="4.5" style={{ fill: scoreColor(it.value) }}><title>{`${it.label}: ${it.value ?? 'n/a'}`}</title></circle> })}
    {items.map((it, i) => {
      const a = angle(i), c = Math.cos(a), s = Math.sin(a)
      return <text key={i} x={cx + (R + 16) * c} y={cy + (R + 16) * s + (s > 0.5 ? 11 : s < -0.5 ? -3 : 4)} fontSize="11.5"
        textAnchor={Math.abs(c) < 0.2 ? 'middle' : c > 0 ? 'start' : 'end'} style={{ fill: 'rgb(var(--fg))' }}>
        {it.label} <tspan fontWeight="700" style={{ fill: scoreColor(it.value) }}>{it.value ?? '–'}</tspan>
      </text>
    })}
  </svg>
}

// items: [{ label, value (0-100 of the track), color, right, title }]
export function BarList({ items, empty = 'Nothing to show.' }) {
  if (!items.length) return <p className="text-xs text-muted">{empty}</p>
  return <ul className="space-y-2.5">{items.map((item, i) => <li key={`${item.label}-${i}`} className="grid grid-cols-[minmax(0,9.5rem)_1fr_auto] items-center gap-3 text-xs" title={item.title || item.label}>
    <span className="truncate text-fg/90">{item.label}</span>
    <span className="sd-track"><span className="sd-fill" style={{ width: `${Math.max(2, Math.min(100, item.value))}%`, background: item.color }} /></span>
    <span className="tabular-nums font-semibold min-w-[3.2rem] text-right">{item.right}</span>
  </li>)}</ul>
}

// segments: [{ label, value, color }]
export function StackedBar({ segments }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (!total) return <p className="text-xs text-muted">No findings.</p>
  return <div>
    <div className="sd-stack" role="img" aria-label={segments.filter(s => s.value).map(s => `${s.value} ${s.label}`).join(', ')}>
      {segments.filter(s => s.value).map(s => <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.value} ${s.label}`}>{s.value}</span>)}
    </div>
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11px] text-muted">
      {segments.map(s => <span key={s.label} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />{s.label} {s.value}</span>)}
    </div>
  </div>
}
