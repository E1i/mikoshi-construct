import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import path from 'node:path'

export const ARCHIVE_DIR = 'archive'

export type CardFileStep = 'moved' | 'archived' | 'absent'

export function archivedCardFile(parking: string, cardId: number): string {
  return path.join(parking, ARCHIVE_DIR, `${cardId}.md`)
}

function parkedCardFile(parking: string, cardId: number): string | undefined {
  if (!existsSync(parking))
    return undefined
  const lanes = readdirSync(parking, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== ARCHIVE_DIR)
    .map(entry => path.join(parking, entry.name))
  return [parking, ...lanes].map(dir => path.join(dir, `${cardId}.md`)).find(file => existsSync(file))
}

export function archiveCardFile(parking: string, cardId: number): CardFileStep {
  const archived = archivedCardFile(parking, cardId)
  if (existsSync(archived))
    return 'archived'
  const parked = parkedCardFile(parking, cardId)
  if (parked === undefined)
    return 'absent'
  mkdirSync(path.dirname(archived), { recursive: true })
  renameSync(parked, archived)
  return 'moved'
}
