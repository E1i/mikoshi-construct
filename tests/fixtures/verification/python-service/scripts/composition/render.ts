import type { CompositionEdge, CompositionModel } from './model.js'

const ARROWS: Record<CompositionEdge['kind'], string> = {
  'sequence': '-->',
  'parallel': '==>',
  'route': '-->',
  'fan-out': '-->',
  'fan-in': '-->',
  'wires': '-.->',
}

const IMPLICIT_LABELS: Partial<Record<CompositionEdge['kind'], string>> = {
  'parallel': 'parallel',
  'fan-out': 'fan-out',
  'fan-in': 'fan-in',
}

function quoted(label: string): string {
  return `"${label.replaceAll('"', '#quot;')}"`
}

function edgeLine(edge: CompositionEdge): string {
  const label = edge.label ?? IMPLICIT_LABELS[edge.kind]
  const link = label == null ? ARROWS[edge.kind] : `${ARROWS[edge.kind]}|${quoted(label)}|`
  return `  ${edge.from} ${link} ${edge.to}`
}

export function renderMermaid(model: CompositionModel): string {
  const lines = ['flowchart LR']
  for (const boundary of model.boundaries) {
    lines.push(`  subgraph b_${boundary.id}[${quoted(boundary.label)}]`)
    for (const node of model.nodes.filter(candidate => candidate.boundary === boundary.id))
      lines.push(`    ${node.id}[${quoted(node.label)}]`)
    lines.push('  end')
  }
  for (const node of model.nodes.filter(candidate => candidate.boundary == null))
    lines.push(`  ${node.id}[${quoted(node.label)}]`)
  for (const edge of model.edges)
    lines.push(edgeLine(edge))
  return `${lines.join('\n')}\n`
}

export function openingMarker(id: string): string {
  return `<!-- composition:${id} -->`
}

export function closingMarker(id: string): string {
  return `<!-- /composition:${id} -->`
}

function markerBounds(doc: string, id: string, docName: string): { start: number, end: number } {
  const start = doc.indexOf(openingMarker(id))
  const end = doc.indexOf(closingMarker(id))
  if (start === -1 || end === -1 || end < start)
    throw new Error(`${docName} is missing the ${openingMarker(id)} … ${closingMarker(id)} block`)
  return { start: start + openingMarker(id).length, end }
}

export function renderEmbedded(model: CompositionModel): string {
  const description = model.description == null ? '' : `${model.description}\n\n`
  return `\n${description}\`\`\`mermaid\n${renderMermaid(model)}\`\`\`\n`
}

export function embed(doc: string, model: CompositionModel, docName: string): string {
  const { start, end } = markerBounds(doc, model.id, docName)
  return doc.slice(0, start) + renderEmbedded(model) + doc.slice(end)
}

export function extractEmbedded(doc: string, model: CompositionModel, docName: string): string {
  const { start, end } = markerBounds(doc, model.id, docName)
  return doc.slice(start, end)
}
