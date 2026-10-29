// Presentation-only adapter. The saved graph and all backend requests stay unchanged.
import ELK from 'elkjs/lib/elk.bundled.js'
import { fileCaptions, FONT } from './flowMermaid.js'

function textTools() {
  const context = document.createElement('canvas').getContext('2d')
  const measure = (text, size = 14, weight = 400) => {
    if (!context) return Array.from(text).length * size
    context.font = `${weight} ${size}px ${FONT}`
    return context.measureText(text).width
  }
  const lines = (text, maxWidth, size = 14, weight = 400) => {
    const result = []
    let line = ''
    for (const char of Array.from(String(text || ''))) {
      if (char === '\n') {
        result.push(line.trimEnd())
        line = ''
      } else if (line && measure(line + char, size, weight) > maxWidth) {
        const split = Math.max(line.lastIndexOf(' '), line.lastIndexOf('/'), line.lastIndexOf('_'), line.lastIndexOf('-'))
        if (split > 0) {
          result.push(line.slice(0, split + 1).trimEnd())
          line = (line.slice(split + 1) + char).trimStart()
        } else {
          result.push(line.trimEnd())
          line = char.trimStart()
        }
      } else line += char
    }
    if (line || !result.length) result.push(line)
    return result
  }
  return { measure, lines }
}

export async function layoutReactGraph(graph, { direction = 'TB', showFiles = true, orthogonal = true } = {}) {
  const { measure, lines } = textTools()
  const horizontal = direction === 'LR'
  const captions = fileCaptions(graph.nodes)
  const nodeData = new Map()
  const edgeData = new Map()
  const groupData = new Map()
  const options = {
    'elk.algorithm': 'layered',
    'elk.direction': horizontal ? 'RIGHT' : 'DOWN',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.json.shapeCoords': 'PARENT',
    'elk.json.edgeCoords': 'PARENT',
    // Compound graphs use orthogonal routing; the standard view rounds bends.
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': '48',
    'elk.spacing.edgeNode': '24',
    'elk.layered.spacing.nodeNodeBetweenLayers': '88',
    'elk.layered.spacing.edgeNodeBetweenLayers': '28',
    'elk.padding': '[top=32,left=32,bottom=32,right=32]',
  }
  const containers = new Map()
  for (const group of graph.groups || []) {
    if (!graph.nodes.some(node => node.group === group.id)) continue
    const labelLines = lines(group.label, 240, 13, 600)
    groupData.set(group.id, { ...group, labelLines })
    containers.set(group.id, {
      id: group.id, children: [], edges: [],
      layoutOptions: { ...options, 'elk.padding': `[top=${36 + labelLines.length * 18},left=32,bottom=32,right=32]` },
    })
  }
  const root = { id: 'qucore-root', layoutOptions: options, children: [...containers.values()], edges: [] }
  for (const node of graph.nodes) {
    const labelLines = lines(node.label, 212, 14, 600)
    const fileLines = showFiles && node.file ? lines(captions[node.file] || node.file, 212, 12) : []
    const contentHeight = labelLines.length * 20 + (fileLines.length ? 10 + fileLines.length * 17 : 0)
    const width = node.kind === 'decision' ? 400 : node.kind === 'api' || node.kind === 'external' ? 300 : 270
    const height = node.kind === 'decision' ? (contentHeight + 48) * 2 : contentHeight + 48
    nodeData.set(node.id, { ...node, labelLines, fileLines, width, height, contentHeight, horizontal })
    const child = {
      id: node.id, width, height,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: [
        { id: `${node.id}:in`, width: 0, height: 0, x: horizontal ? 0 : width / 2, y: horizontal ? height / 2 : 0,
          layoutOptions: { 'elk.port.side': horizontal ? 'WEST' : 'NORTH' } },
        { id: `${node.id}:out`, width: 0, height: 0, x: horizontal ? width : width / 2, y: horizontal ? height / 2 : height,
          layoutOptions: { 'elk.port.side': horizontal ? 'EAST' : 'SOUTH' } },
      ],
    }
    ;(containers.get(node.group)?.children || root.children).push(child)
  }
  const originals = new Map(graph.nodes.map(node => [node.id, node]))
  graph.edges.forEach((edge, index) => {
    const id = `qucore-edge-${index}`
    const labelLines = edge.label ? lines(edge.label, 156, 12) : []
    const labelWidth = labelLines.length ? Math.max(...labelLines.map(line => measure(line, 12))) + 16 : 0
    const labelHeight = labelLines.length * 17 + 10
    edgeData.set(id, { ...edge, id, labelLines, labelWidth, labelHeight })
    const sourceGroup = originals.get(edge.from)?.group
    const targetGroup = originals.get(edge.to)?.group
    const parent = sourceGroup && sourceGroup === targetGroup ? containers.get(sourceGroup) : root
    ;(parent || root).edges.push({
      id, sources: [`${edge.from}:out`], targets: [`${edge.to}:in`],
      labels: labelLines.length ? [{ id: `${id}:label`, text: labelLines.join('\n'), width: labelWidth, height: labelHeight }] : [],
    })
  })
  // The bundled ELK build uses an in-process worker shim, not a Web Worker.
  // Calling terminateWorker() here can throw after a successful layout and
  // discard its result. This per-layout instance is released normally by GC.
  const elk = new ELK()
  const result = await elk.layout(root)
  const groups = [], nodes = [], edges = []
  function visit(container, offset = { x: 0, y: 0 }) {
    for (const child of container.children || []) {
      const absolute = { x: offset.x + child.x, y: offset.y + child.y }
      const position = { x: child.x, y: child.y }
      if (groupData.has(child.id)) {
        groups.push({ ...groupData.get(child.id), ...absolute, width: child.width, height: child.height })
        visit(child, absolute)
      } else {
        nodes.push({ ...nodeData.get(child.id), ...absolute, position,
          parentId: groupData.has(container.id) ? container.id : undefined })
      }
    }
    for (const edge of container.edges || []) {
      const data = edgeData.get(edge.id)
      if (!data || !edge.sections?.length) throw new Error('A connection could not be routed. Try the other layout or Mermaid.')
      const paths = edge.sections.map(section => {
        const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint]
        return routePath(points.map(point => ({ x: point.x + offset.x, y: point.y + offset.y })), !orthogonal)
      })
      const label = edge.labels?.[0]
      edges.push({ ...data, paths,
        labelX: label ? label.x + offset.x : 0, labelY: label ? label.y + offset.y : 0 })
    }
  }
  visit(result)
  if (nodes.length !== graph.nodes.length || edges.length !== graph.edges.length) {
    throw new Error('The layout did not retain every step and connection. Switch to Mermaid to view the saved graph.')
  }
  return { groups, nodes, edges, width: result.width, height: result.height }
}

function routePath(points, rounded) {
  if (!rounded || points.length < 3) return points.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
  const path = [`M ${points[0].x} ${points[0].y}`]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1]
    const before = Math.hypot(b.x - a.x, b.y - a.y)
    const after = Math.hypot(c.x - b.x, c.y - b.y)
    if (!before || !after) { path.push(`L ${b.x} ${b.y}`); continue }
    const r = Math.min(10, before / 2, after / 2)
    path.push(`L ${b.x - (b.x - a.x) * r / before} ${b.y - (b.y - a.y) * r / before}`)
    path.push(`Q ${b.x} ${b.y} ${b.x + (c.x - b.x) * r / after} ${b.y + (c.y - b.y) * r / after}`)
  }
  const last = points[points.length - 1]
  path.push(`L ${last.x} ${last.y}`)
  return path.join(' ')
}
