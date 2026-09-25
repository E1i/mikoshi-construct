import type { ModelGraph, PictureClass, PictureNode, PictureNodeKind } from './graph.js'

const COLUMN_OF: Record<PictureNodeKind, number> = { claim: 0, hypothesis: 0, fact: 1 }
const COLUMN_TITLES = ['Claims and hypotheses', 'Evidence']

const CHAR_WIDTH = 7.1
export const LINE_HEIGHT = 18
const NODE_PADDING = 12
const NODE_GAP = 16
const COLUMN_GAP = 220
const MARGIN = 32
const HEADING = 52
const MAX_LINE = 58

export interface PlacedNode {
  node: PictureNode
  x: number
  y: number
  width: number
  height: number
  lines: string[]
}

const TAIL_KEPT = 28

function elided(line: string): string {
  if (line.length <= MAX_LINE)
    return line
  const head = MAX_LINE - 1 - TAIL_KEPT
  return `${line.slice(0, head)}…${line.slice(-TAIL_KEPT)}`
}

function wrapped(node: PictureNode): string[] {
  return node.lines.map(elided)
}

function widthOf(lines: string[]): number {
  return Math.round(Math.max(...lines.map(line => line.length)) * CHAR_WIDTH) + NODE_PADDING * 2
}

function heightOf(lines: string[]): number {
  return lines.length * LINE_HEIGHT + NODE_PADDING * 2
}

export function layout(graph: ModelGraph): { placed: PlacedNode[], width: number, height: number } {
  const columns: PlacedNode[][] = [[], []]
  const widths = [0, 0]
  for (const node of graph.nodes) {
    const lines = wrapped(node)
    const column = COLUMN_OF[node.kind]
    widths[column] = Math.max(widths[column] ?? 0, widthOf(lines))
    columns[column]?.push({ node, x: 0, y: 0, width: widthOf(lines), height: heightOf(lines), lines })
  }

  const placed: PlacedNode[] = []
  let tallest = 0
  columns.forEach((column, index) => {
    const x = MARGIN + (index === 0 ? 0 : (widths[0] ?? 0) + COLUMN_GAP)
    let y = MARGIN + HEADING
    for (const entry of column) {
      placed.push({ ...entry, x, y, width: widths[index] ?? entry.width })
      y += entry.height + NODE_GAP
    }
    tallest = Math.max(tallest, y)
  })

  return {
    placed,
    width: MARGIN * 2 + (widths[0] ?? 0) + COLUMN_GAP + (widths[1] ?? 0),
    height: tallest - NODE_GAP + MARGIN,
  }
}

function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function shape(entry: PlacedNode): string {
  const { x, y, width, height, node } = entry
  if (node.kind === 'hypothesis')
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${Math.round(height / 2)}" class="box ${node.state}"/>`
  if (node.kind === 'fact') {
    const slant = 10
    return `<polygon points="${x + slant},${y} ${x + width},${y} ${x + width - slant},${y + height} ${x},${y + height}" class="box ${node.state}"/>`
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" class="box ${node.state}"/>`
}

function text(entry: PlacedNode): string {
  return entry.lines
    .map((line, index) => `<text x="${entry.x + NODE_PADDING}" y="${entry.y + NODE_PADDING + LINE_HEIGHT * index + 13}" class="label${index === 0 ? ' first' : ''}">${escaped(line)}</text>`)
    .join('\n    ')
}

interface Curve {
  path: string
  midX: number
  midY: number
}

export const LABEL_SEPARATION = LINE_HEIGHT

const MIDPOINT_MOVES_BY_THIS_SHARE_OF_THE_CONTROL_OFFSET = 0.75
const PARALLEL_SPREAD = LABEL_SEPARATION / MIDPOINT_MOVES_BY_THIS_SHARE_OF_THE_CONTROL_OFFSET

function curve(from: PlacedNode, to: PlacedNode, spread: number): Curve {
  const x1 = from.x + from.width
  const y1 = from.y + from.height / 2
  const x2 = to.x
  const y2 = to.y + to.height / 2
  const bend = Math.max(40, (x2 - x1) / 2)
  const c1x = x1 + bend
  const c2x = x2 - bend
  const c1y = y1 + spread
  const c2y = y2 + spread
  return {
    path: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
    midX: Math.round((x1 + 3 * c1x + 3 * c2x + x2) / 8),
    midY: Math.round((y1 + 3 * c1y + 3 * c2y + y2) / 8),
  }
}

function spreadOfParallelEdges(edges: readonly { from: string, to: string }[]): number[] {
  const seen = new Map<string, number>()
  const total = new Map<string, number>()
  for (const edge of edges) {
    const pair = `${edge.from}->${edge.to}`
    total.set(pair, (total.get(pair) ?? 0) + 1)
  }
  return edges.map((edge) => {
    const pair = `${edge.from}->${edge.to}`
    const index = seen.get(pair) ?? 0
    seen.set(pair, index + 1)
    const count = total.get(pair) ?? 1
    return count === 1 ? 0 : (index - (count - 1) / 2) * PARALLEL_SPREAD
  })
}

interface LabelAnchor {
  x: number
  y: number
}

function noCloserThanOneLine(anchors: LabelAnchor[]): LabelAnchor[] {
  const placed: LabelAnchor[] = []
  return anchors.map((anchor) => {
    let candidate = anchor
    while (placed.some(other => Math.hypot(candidate.x - other.x, candidate.y - other.y) < LABEL_SEPARATION))
      candidate = { x: candidate.x, y: candidate.y + LABEL_SEPARATION }
    placed.push(candidate)
    return candidate
  })
}

export function svgFromGraph(graph: ModelGraph): string {
  const { placed, width, height } = layout(graph)
  const byId = new Map(placed.map(entry => [entry.node.id, entry]))

  const spreads = spreadOfParallelEdges(graph.edges)
  const drawn = graph.edges.map((edge, index) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    return from == null || to == null ? null : { edge, from, curve: curve(from, to, spreads[index] ?? 0) }
  })
  const anchors = noCloserThanOneLine(
    drawn.flatMap(entry => (entry == null || entry.edge.stage == null ? [] : [{ x: entry.curve.midX, y: entry.curve.midY - 6 }])),
  )
  let anchorIndex = 0
  const edges = drawn.flatMap((entry) => {
    if (entry == null)
      return []
    if (entry.edge.stage == null)
      return [`<path d="${entry.curve.path}" class="edge ${entry.from.node.state}"/>`]
    const anchor = anchors[anchorIndex]
    anchorIndex += 1
    const label = `\n    <text x="${anchor?.x ?? entry.curve.midX}" y="${anchor?.y ?? entry.curve.midY}" class="stage" text-anchor="middle">${escaped(entry.edge.stage)}</text>`
    return [`<path d="${entry.curve.path}" class="edge ${entry.from.node.state}"/>${label}`]
  })

  const headings = COLUMN_TITLES.map((title, index) => {
    const first = placed.find(entry => COLUMN_OF[entry.node.kind] === index)
    return first == null ? '' : `<text x="${first.x}" y="${MARGIN + 28}" class="heading">${escaped(title)}</text>`
  }).filter(heading => heading !== '')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="What this repository claims and the evidence under it">`,
    `  <g class="edges">`,
    ...edges.map(edge => `    ${edge}`),
    `  </g>`,
    `  <g class="headings">`,
    ...headings.map(heading => `    ${heading}`),
    `  </g>`,
    `  <g class="nodes">`,
    ...placed.flatMap(entry => [`    ${shape(entry)}`, `    ${text(entry)}`]),
    `  </g>`,
    `</svg>`,
  ].join('\n')
}

export const COLOUR_IS_NOT_STRENGTH = 'Colour carries the derived state and not the enforcement level: the same green covers an L0 claim nobody is obliged to read and an L3 claim that fails the build, and each claim\u2019s level is written inside it.'

export const STATE_LEGEND: Record<PictureClass, string> = {
  'held': 'every fact named under it was read and holds',
  'unsupported': 'every fact was read and at least one does not hold',
  'unknown': 'no fact is named, or a named fact could not be read',
  'runtime-report': 'stands on a runner\u2019s report, which doctor reads at run time and the picture never reads',
}
