// Turns the validated flow graph from the backend into Mermaid flowchart text.
// The model never writes Mermaid itself: ids, shapes, escaping and line wrapping
// are all decided here, so the diagram always parses and labels stay inside boxes.

export const FONT = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif'

// [fill, stroke] per theme. Text colour comes from the theme below.
export const KINDS = {
  input:    { label: 'Input / trigger',  open: '([', close: '])', light: ['#E3F4EA', '#1A7F4B'], dark: ['#123224', '#3FB978'] },
  ui:       { label: 'User interface',   open: '(',  close: ')',  light: ['#ECEEFE', '#4F46E5'], dark: ['#1F2048', '#8B8FF5'] },
  api:      { label: 'API / handler',    open: '{{', close: '}}', light: ['#E1F1FB', '#0369A1'], dark: ['#0E2A3D', '#4CB2EC'] },
  process:  { label: 'Processing step',  open: '[',  close: ']',  light: ['#F4F6FA', '#5C647E'], dark: ['#1D2233', '#8B91A7'] },
  service:  { label: 'Service / module', open: '[[', close: ']]', light: ['#FDF1E3', '#B45309'], dark: ['#35230F', '#E1A040'] },
  decision: { label: 'Decision',         open: '{',  close: '}',  light: ['#FEF6D8', '#A16207'], dark: ['#332B0E', '#E1AC40'] },
  data:     { label: 'Data store',       open: '[(', close: ')]', light: ['#F3EAFD', '#7E22CE'], dark: ['#2A1840', '#B784F0'] },
  external: { label: 'External service', open: '[/', close: '/]', light: ['#FCE8F1', '#BE185D'], dark: ['#3A1426', '#EC6FA5'] },
  output:   { label: 'Output / result',  open: '([', close: '])', light: ['#DDF3F0', '#0F766E'], dark: ['#0E302C', '#3CC3B4'] },
}

export const THEMES = {
  light: { text: '#1C2030', muted: '#5C647E', line: '#8A93AD', bg: '#FFFFFF', cluster: '#F6F8FC', clusterBorder: '#CBD2E1', edgeLabel: '#FFFFFF' },
  dark:  { text: '#E6E8F0', muted: '#9CA3BC', line: '#6B7390', bg: '#11141F', cluster: '#161A28', clusterBorder: '#2E3550', edgeLabel: '#11141F' },
}

export function mermaidConfig(light) {
  const t = light ? THEMES.light : THEMES.dark
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    htmlLabels: false, // pure SVG text: exact measurement and a PNG export that never taints the canvas
    fontFamily: FONT,
    flowchart: {
      htmlLabels: false, curve: 'basis', padding: 18, nodeSpacing: 46, rankSpacing: 62,
      diagramPadding: 20, useMaxWidth: false, wrappingWidth: 320,
    },
    themeVariables: {
      fontFamily: FONT, fontSize: '14px', background: t.bg,
      primaryColor: light ? '#F4F6FA' : '#1D2233', primaryTextColor: t.text, primaryBorderColor: t.line,
      lineColor: t.line, textColor: t.text, titleColor: t.muted,
      clusterBkg: t.cluster, clusterBorder: t.clusterBorder,
      edgeLabelBackground: t.edgeLabel, tertiaryColor: t.cluster,
    },
  }
}

const escape = text => String(text)
  .replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;')

// Greedy word wrap; very long tokens (paths, identifiers) break at / . _ - or hard.
export function wrap(text, width) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  const push = word => {
    if (!line) line = word
    else if ((line + ' ' + word).length <= width) line += ' ' + word
    else { lines.push(line); line = word }
  }
  for (let word of words) {
    while (word.length > width) {
      const slice = word.slice(0, width)
      const cut = Math.max(slice.lastIndexOf('/'), slice.lastIndexOf('.'), slice.lastIndexOf('_'), slice.lastIndexOf('-'))
      const at = cut > width / 3 ? cut + 1 : width
      push(word.slice(0, at)); word = word.slice(at)
    }
    if (word) push(word)
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

// Short, unique file captions: basename, or parent/basename when basenames clash.
export function fileCaptions(nodes) {
  const files = [...new Set(nodes.map(n => n.file).filter(Boolean))]
  const base = f => f.split('/').pop()
  const counts = {}
  files.forEach(f => { counts[base(f)] = (counts[base(f)] || 0) + 1 })
  return Object.fromEntries(files.map(f => [f, counts[base(f)] > 1 ? f.split('/').slice(-2).join('/') : base(f)]))
}

export function buildMermaid(graph, { direction = 'TB', showFiles = true, light = true } = {}) {
  const captions = fileCaptions(graph.nodes)
  const palette = light ? 'light' : 'dark'
  const text = light ? THEMES.light.text : THEMES.dark.text
  const out = [`flowchart ${direction === 'LR' ? 'LR' : 'TB'}`]
  const node = n => {
    const meta = KINDS[n.kind] || KINDS.process
    const width = n.kind === 'decision' ? 16 : n.kind === 'api' || n.kind === 'external' ? 20 : 24
    const lines = wrap(n.label, width).map(escape)
    if (showFiles && n.file) lines.push(...wrap(captions[n.file] || n.file, 28).map(escape))
    return `${n.id}${meta.open}"${lines.join('<br/>')}"${meta.close}`
  }
  const loose = graph.nodes.filter(n => !n.group)
  for (const group of graph.groups) {
    const members = graph.nodes.filter(n => n.group === group.id)
    if (!members.length) continue
    out.push(`  subgraph ${group.id}["${wrap(group.label, 40).map(escape).join('<br/>')}"]`)
    members.forEach(n => out.push('    ' + node(n)))
    out.push('  end')
  }
  loose.forEach(n => out.push('  ' + node(n)))
  for (const edge of graph.edges) {
    const arrow = edge.style === 'dashed' ? '-.->' : '-->'
    const label = edge.label ? `|"${wrap(edge.label, 18).map(escape).join('<br/>')}"|` : ''
    out.push(`  ${edge.from} ${arrow}${label} ${edge.to}`)
  }
  for (const [kind, meta] of Object.entries(KINDS)) {
    const ids = graph.nodes.filter(n => (KINDS[n.kind] ? n.kind : 'process') === kind).map(n => n.id)
    if (!ids.length) continue
    const [fill, stroke] = meta[palette]
    out.push(`  classDef k_${kind} fill:${fill},stroke:${stroke},stroke-width:1.6px,color:${text}`)
    out.push(`  class ${ids.join(',')} k_${kind}`)
  }
  return out.join('\n')
}
