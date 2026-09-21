import type { ModelPicture } from '../../src/model/graph.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PICTURE_PROSE } from '../../src/model/graph.js'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PICTURE_DOC = 'architecture/model.md'
export const PICTURE_DOC_PATH = path.join(REPO_ROOT, PICTURE_DOC)

export const OPENING_MARKER = '<!-- model:picture -->'
export const CLOSING_MARKER = '<!-- /model:picture -->'

export function renderEmbedded(picture: ModelPicture): string {
  const prose = PICTURE_PROSE[picture.at]
  if (picture.at !== 'drawn')
    return `\n${prose}\n`
  return `\n${prose}\n\n\`\`\`mermaid\n${picture.mermaid}\`\`\`\n`
}

function markerBounds(doc: string, docName: string): { start: number, end: number } {
  const start = doc.indexOf(OPENING_MARKER)
  const end = doc.indexOf(CLOSING_MARKER)
  if (start === -1 || end === -1 || end < start)
    throw new Error(`${docName} is missing the ${OPENING_MARKER} … ${CLOSING_MARKER} block`)
  return { start: start + OPENING_MARKER.length, end }
}

export function embed(doc: string, picture: ModelPicture, docName: string): string {
  const { start, end } = markerBounds(doc, docName)
  return doc.slice(0, start) + renderEmbedded(picture) + doc.slice(end)
}

export function extractEmbedded(doc: string, docName: string): string {
  const { start, end } = markerBounds(doc, docName)
  return doc.slice(start, end)
}

export function staleProblems(doc: string, picture: ModelPicture, docName: string): string[] {
  if (extractEmbedded(doc, docName) === renderEmbedded(picture))
    return []
  return [`${docName}: the picture of construct.model.json is out of date; run pnpm model:render`]
}
