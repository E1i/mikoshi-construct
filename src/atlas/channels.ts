import type { Relation } from '../model/schema.js'

export interface MapChannel {
  file: string
  writer: string
  writerAt: string
  reader: string
  readerAt: string
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function pairKey(writer: string, reader: string, file: string): string {
  return [writer, reader, file].join('\u0000')
}

export function channelMap(relations: readonly Relation[]): MapChannel[] {
  const readerLines = new Map<string, number>()
  for (const relation of relations) {
    if (relation.kind === 'reads' && relation.to != null)
      readerLines.set(pairKey(relation.to, relation.from, relation.specifier), relation.source.line)
  }
  return relations.flatMap((relation) => {
    const readerLine = relation.kind === 'writes' && relation.to != null ? readerLines.get(pairKey(relation.from, relation.to, relation.specifier)) : undefined
    if (readerLine === undefined || relation.to == null)
      return []
    return [{ file: relation.specifier, writer: relation.from, writerAt: `${relation.from}:${relation.source.line}`, reader: relation.to, readerAt: `${relation.to}:${readerLine}` }]
  }).sort((left, right) => compare(left.file, right.file) || compare(left.writerAt, right.writerAt) || compare(left.readerAt, right.readerAt))
}
