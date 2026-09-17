import { detectExisting } from './existing.js'

export function factsTheRepositoryEstablishes(root: string): Record<string, string> {
  const existing = detectExisting(root)
  return existing.compositionDir == null ? {} : { compositionDir: existing.compositionDir }
}
