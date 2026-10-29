import { isValidElement, memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, FileCode2 } from 'lucide-react'

// `path/to/file.py:10-25`, `file.py:10`, `file.py#L10-L25` or `path/to/file.py`
const CITE = /^((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?:(?::|#L)L?(\d+)(?:\s*[-–]\s*L?(\d+))?)?$/

function text(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (isValidElement(node)) return text(node.props.children)
  return ''
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false)
  return <div className="qa-code">
    <div className="qa-code-bar">
      <span>{language || 'code'}</span>
      <button type="button" className="btn-small py-0.5!" onClick={async () => {
        try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
      }}>{copied ? <><Check size={12} />Copied</> : <><Copy size={12} />Copy</>}</button>
    </div>
    <pre><code>{code}</code></pre>
  </div>
}

// Resolve a cited path against the files this answer used (exact, suffix or unique file name).
export function resolveCitation(value, paths) {
  const match = CITE.exec(String(value || '').trim())
  if (!match) return null
  const raw = match[1].replace(/^\.\//, '')
  let path = paths.find(p => p === raw) || null
  if (!path) {
    const suffix = paths.filter(p => p.endsWith('/' + raw))
    if (suffix.length === 1) path = suffix[0]
  }
  if (!path && !raw.includes('/')) {
    const same = paths.filter(p => p.split('/').pop() === raw)
    if (same.length === 1) path = same[0]
  }
  if (!path) return null
  const start = match[2] ? Number(match[2]) : null
  const end = match[3] ? Number(match[3]) : start
  return { path, start: start && end ? Math.min(start, end) : null, end: start && end ? Math.max(start, end) : null }
}

function QAMarkdown({ text: source, paths = [], onCite }) {
  return <div className="report-markdown qa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    // Fenced blocks are rendered here directly; the inner <code> element is only read, not rendered.
    pre: ({ node, children }) => {
      const child = Array.isArray(children) ? children[0] : children
      const className = isValidElement(child) ? child.props.className || '' : ''
      const language = (/language-([\w+#.-]+)/.exec(className) || [])[1] || ''
      return <CodeBlock language={language} code={text(isValidElement(child) ? child.props.children : children).replace(/\n$/, '')} />
    },
    code: ({ node, children, className }) => {
      const value = text(children)
      const cite = onCite && !className ? resolveCitation(value, paths) : null
      if (cite) {
        return <button type="button" className="qa-cite" title="Open this code" onClick={() => onCite(cite)}>
          <FileCode2 size={11} />{value}
        </button>
      }
      return <code className={className}>{children}</code>
    },
    table: ({ node, children }) => <div className="qa-table"><table>{children}</table></div>,
    a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
    img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
  }}>{source || ''}</ReactMarkdown></div>
}

export default memo(QAMarkdown)
