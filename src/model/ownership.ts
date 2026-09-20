import type { EntryAuthor } from './schema.js'

export interface AuthoredEntry {
  id: string
  authoredBy: EntryAuthor
}

export type OwnerReader = (entry: AuthoredEntry) => EntryAuthor

export const authoredByOwner: OwnerReader = entry => entry.authoredBy
