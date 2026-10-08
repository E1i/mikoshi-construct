import type { AtlasMechanics } from './view.js'
import { escaped } from '../model/page.js'
import { LINE_HEIGHT } from '../model/svg.js'
import { componentWords } from './words.js'

const BOX_WIDTH = 260
const GAP = 12
const COLUMN_GAP = 120
const MARGIN = 8

function row(index: number): number {
  return MARGIN + index * (LINE_HEIGHT + GAP)
}

function relationsAmong(mechanics: AtlasMechanics, paths: readonly string[]): AtlasMechanics['relations'] {
  const wanted = new Set(paths)
  return mechanics.relations.filter(relation => wanted.has(relation.from))
}

export function schemeOfMechanics(mechanics: AtlasMechanics, paths: readonly string[]): string {
  const relations = relationsAmong(mechanics, paths)
  const unread = new Map(mechanics.components.flatMap((component) => {
    const words = componentWords(component)
    return words == null ? [] : [[component.path, words] as const]
  }))
  const sources = [...paths].sort()
  const targets = [...new Set(relations.map(relation => relation.to ?? `unknown: ${relation.specifier}`))].sort()
  const height = row(Math.max(sources.length, targets.length)) + MARGIN
  const width = MARGIN * 2 + BOX_WIDTH * 2 + COLUMN_GAP
  const rightX = MARGIN + BOX_WIDTH + COLUMN_GAP
  const box = (x: number, index: number, label: string, state: string, note?: string): string =>
    `<g data-state="${state}">${note == null ? '' : `<title>${escaped(`${label}: ${note}`)}</title>`}<rect x="${x}" y="${row(index)}" width="${BOX_WIDTH}" height="${LINE_HEIGHT + 4}" rx="4"/><text x="${x + 6}" y="${row(index) + 14}">${escaped(label)}</text></g>`
  const edges = relations.map((relation) => {
    const target = relation.to ?? `unknown: ${relation.specifier}`
    const y1 = row(sources.indexOf(relation.from)) + (LINE_HEIGHT + 4) / 2
    const y2 = row(targets.indexOf(target)) + (LINE_HEIGHT + 4) / 2
    const state = relation.to == null ? 'unknown' : 'held'
    return `<path d="M ${MARGIN + BOX_WIDTH} ${y1} L ${rightX} ${y2}" data-state="${state}"><title>${escaped(`${relation.from}:${relation.source.line} ${relation.kind} ${relation.specifier}`)}</title></path>`
  })
  return [
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Which code reaches which">`,
    ...edges,
    ...sources.map((label, index) => box(MARGIN, index, label, unread.has(label) ? 'unknown' : 'held', unread.get(label))),
    ...targets.map((label, index) => box(rightX, index, label, label.startsWith('unknown: ') ? 'unknown' : 'held')),
    `</svg>`,
  ].join('\n')
}
