// Finds the "Current ... / Fixed ..." code pairs in a SonarCute fix report (Markdown), so each can be
// applied to the file as a reviewable change.
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const plain = text => text.replace(/[*_`#>]/g, '').trim()

export function extractSonarChanges(markdown) {
  const lines = String(markdown || '').split('\n')
  const out = []
  let title = ''
  let pending = null
  for (let i = 0; i < lines.length; i++) {
    const heading = /^#{2,4}\s+(.*)$/.exec(lines[i])
    if (heading && /issue\s*\d+/i.test(heading[1])) { title = plain(heading[1]); pending = null; continue }
    const label = plain(lines[i])
    const isCurrent = /^(current|before|original)\b/i.test(label)
    const isFixed = /^(fixed|proposed|after|corrected|new code)\b/i.test(label)
    if (!(isCurrent || isFixed) || label.length > 90) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const open = FENCE.exec(lines[j] || '')
    if (!open) continue
    const body = []
    let k = j + 1
    while (k < lines.length && !lines[k].trim().startsWith(open[1])) { body.push(lines[k]); k++ }
    const code = body.join('\n')
    if (isCurrent) {
      const range = /lines?\s*(\d+)(?:\s*[-–]\s*(\d+))?/i.exec(label)
      pending = { title, line_start: range ? Number(range[1]) : null, line_end: range ? Number(range[2] || range[1]) : null, before_code: code }
    } else if (pending && pending.before_code.trim()) {
      out.push({ ...pending, after_code: code })
      pending = null
    }
    i = k
  }
  return out
}

// Streaming helper for QuCoder: shows edit blocks as readable diffs while they are being written.
// Models sometimes run "FILE: a.py" into the sentence before it or put a marker at the end of a code line.
// Same rules as normalize() in backend/app/qucoder.py.
export function normalizeEdits(text) {
  return String(text || '').replace(/\r\n/g, '\n')
    .replace(/(?<=\S)(?<!\bNEW)[ \t]*(?=(?:NEW FILE|FILE)[ \t]*:[ \t]*[^\s<>]+[ \t]*\n?[ \t]*<<<<<<<)/gi, '\n')
    .replace(/(?<=\S)[ \t]*(<<<<<<<[ \t]*(?:SEARCH|WHOLE|CONTENT)\b)/gi, '\n$1')
    .replace(/(?<=\S)[ \t]*(>>>>>>>[ \t]*(?:REPLACE|END)\b)/gi, '\n$1')
}

// Same rule as _divider() in backend/app/qucoder.py: exactly seven "=" on their own line; a looser rule
// only when there is no exact one (a Markdown underline also looks like "=====").
function dividerIndex(lines, from, to) {
  for (let j = from; j < to; j++) if (lines[j].trim() === '=======') return j
  for (let j = from; j < to; j++) if (/^={5,}$/.test(lines[j].trim())) return j
  return -1
}

// Line diff (longest common subsequence) so a small change inside a long block shows only what changed.
function lineDiff(before, after) {
  const n = before.length
  const m = after.length
  if (n * m > 160000) return [...before.map(l => `- ${l}`), ...after.map(l => `+ ${l}`)]
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--)
    table[a][b] = before[a] === after[b] ? table[a + 1][b + 1] + 1 : Math.max(table[a + 1][b], table[a][b + 1])
  const out = []
  let a = 0
  let b = 0
  while (a < n && b < m) {
    if (before[a] === after[b]) { out.push(`  ${before[a]}`); a++; b++ }
    else if (table[a + 1][b] >= table[a][b + 1]) out.push(`- ${before[a++]}`)
    else out.push(`+ ${after[b++]}`)
  }
  while (a < n) out.push(`- ${before[a++]}`)
  while (b < m) out.push(`+ ${after[b++]}`)
  return out
}

// A fence one backtick longer than any run inside the code, so code that contains ``` (Markdown, docs,
// templates) can never close it early.
function fenceFor(code) {
  const longest = Math.max(0, ...(code.match(/`+/g) || []).map(run => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

// Turns the edit blocks in an answer into readable Markdown (a labelled, fenced diff or file per block),
// whatever the language of the file. Everything outside the blocks is left as written. While the answer
// streams, an unfinished block is shown as far as it has arrived.
export function prettyEdits(text) {
  const lines = normalizeEdits(text).split('\n')
  // a marker that is still being typed ("<<<<", "====") must not flash as text
  while (lines.length && /^(<{1,6}|={1,6}|>{1,6})$/.test(lines[lines.length - 1].trim())) lines.pop()
  const out = []
  let path = ''
  let isNew = false
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim()
    const header = /^(NEW FILE|FILE)\s*:\s*(.+)$/i.exec(stripped.replace(/^[`*#>\s]+|[`*#>\s]+$/g, ''))
    if (header && !stripped.startsWith('<<<<<<<')) { path = header[2].replace(/[`'"*]/g, '').trim(); isNew = /^new/i.test(header[1]); continue }
    if (stripped.startsWith('<<<<<<<') && path) {
      const tag = stripped.slice(7).trim().toUpperCase()
      const search = tag.startsWith('SEARCH')
      let end = i + 1
      while (end < lines.length && !lines[end].trim().startsWith('>>>>>>>')) end++
      const closed = end < lines.length
      const body = lines.slice(i + 1, end)
      if (!closed) while (body.length && !body[body.length - 1].trim()) body.pop()  // still streaming
      let first = body
      let second = []
      if (search) {
        const split = dividerIndex(body, 0, body.length)
        if (split >= 0) { first = body.slice(0, split); second = body.slice(split + 1) }
      }
      const label = search ? `Edit \`${path}\`` : isNew || tag.startsWith('CONTENT') ? `New file \`${path}\`` : `Rewrite \`${path}\``
      const shown = search ? lineDiff(first, second).join('\n') : first.join('\n')
      const lang = search ? 'diff' : (/\.(\w+)$/.exec(path) || [])[1] || ''
      const fence = fenceFor(shown)
      out.push(`\n**${label}**${closed ? '' : ' …'}\n\n${fence}${lang}\n${shown}\n${fence}\n`)
      i = closed ? end : lines.length
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}
