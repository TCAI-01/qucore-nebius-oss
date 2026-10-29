// Turns a validated UML spec (from the backend) into something a renderer can draw.
// Class, object and sequence diagrams become Mermaid text; activity, state and use case diagrams become
// the same graph format the Flow tab already draws (so both Mermaid and React Flow can show them).

export const DIAGRAM_LABELS = {
  class: 'Class diagram', sequence: 'Sequence diagram', activity: 'Activity diagram',
  state: 'State diagram', usecase: 'Use case diagram', object: 'Object diagram',
}
export const GRAPH_TYPES = new Set(['activity', 'state', 'usecase'])

const text = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/["`{}|\\;#]/g, '').replace(/</g, '~').replace(/>/g, '~').trim()
const label = value => text(value).replace(/[[\]]/g, m => (m === '[' ? '(' : ')'))

export function specToMermaid(spec) {
  const out = []
  if (spec.diagram === 'sequence') {
    out.push('sequenceDiagram', '  autonumber')
    for (const p of spec.participants) out.push(`  ${p.kind === 'actor' ? 'actor' : 'participant'} ${p.id} as ${label(p.label) || p.id}`)
    for (const m of spec.messages) {
      const arrow = m.kind === 'return' ? '-->>' : m.kind === 'async' ? '-)' : '->>'
      out.push(`  ${m.from}${arrow}${m.to}: ${label(m.text)}`)
    }
    return out.join('\n')
  }
  out.push('classDiagram', '  direction TB')
  if (spec.diagram === 'object') {
    for (const o of spec.objects) {
      out.push(`  class ${o.id}["${label(o.name)}${o.class ? ' : ' + label(o.class) : ''}"] {`)
      for (const f of o.fields) out.push(`    ${label(f)}`)
      out.push('  }')
    }
    for (const l of spec.links) out.push(`  ${l.from} --> ${l.to}${l.label ? ' : ' + label(l.label) : ''}`)
    return out.join('\n')
  }
  for (const c of spec.classes) {
    out.push(`  class ${c.id}${c.name !== c.id ? `["${label(c.name)}"]` : ''} {`)
    if (c.stereotype) out.push(`    <<${c.stereotype}>>`)
    for (const a of c.attributes) out.push(`    ${label(a)}`)
    for (const m of c.methods) out.push(`    ${label(m).replace(/\)\s*:\s*/, ') ')}`)   // Mermaid wants the return type after a space
    out.push('  }')
  }
  const arrows = { inherits: (a, b) => `${b} <|-- ${a}`, implements: (a, b) => `${b} <|.. ${a}`, composes: (a, b) => `${a} *-- ${b}`,
    aggregates: (a, b) => `${a} o-- ${b}`, associates: (a, b) => `${a} --> ${b}`, depends: (a, b) => `${a} ..> ${b}` }
  for (const r of spec.relations) out.push(`  ${(arrows[r.type] || arrows.associates)(r.from, r.to)}${r.label ? ' : ' + label(r.label) : ''}`)
  return out.join('\n')
}

// Activity / state / use case -> the Flow tab's graph format ({ nodes, edges, groups }).
export function specToGraph(spec) {
  const ids = new Map()
  const nodes = []
  const add = (id, name, kind, group = '') => {
    const nid = `N${nodes.length + 1}`
    ids.set(id, nid)
    nodes.push({ id: nid, label: name, kind, group, file: '', detail: '' })
  }
  const groups = []
  let rawEdges = []
  if (spec.diagram === 'activity') {
    const kinds = { start: 'input', end: 'output', decision: 'decision', action: 'process' }
    spec.nodes.forEach(n => add(n.id, n.label, kinds[n.kind] || 'process'))
    rawEdges = spec.edges.map(e => ({ ...e, style: 'solid' }))
  } else if (spec.diagram === 'state') {
    const kinds = { initial: 'input', final: 'output', state: 'service' }
    spec.states.forEach(s => add(s.id, s.label, kinds[s.kind] || 'service'))
    rawEdges = spec.transitions.map(e => ({ ...e, style: 'solid' }))
  } else {
    groups.push({ id: 'G1', label: spec.system || 'System' })
    spec.actors.forEach(a => add(a.id, a.label, 'ui'))
    spec.usecases.forEach(u => add(u.id, u.label, 'output', 'G1'))
    rawEdges = spec.links.map(l => ({ from: l.from, to: l.to, label: l.type === 'association' ? '' : `«${l.type}»`, style: l.type === 'association' ? 'solid' : 'dashed' }))
  }
  const edges = rawEdges.filter(e => ids.has(e.from) && ids.has(e.to)).map(e => ({ from: ids.get(e.from), to: ids.get(e.to), label: e.label || '', style: e.style }))
  return { title: spec.title, overview: spec.description, groups, nodes, edges, steps: [], notes: spec.notes || [] }
}
