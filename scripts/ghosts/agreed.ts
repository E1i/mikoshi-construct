import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const AGREED_TEXT_PATH = '.construct/implement-agreed.txt'

export function writeAgreedText(worktree: string, approvedText: string): string {
  const file = path.join(worktree, AGREED_TEXT_PATH)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, approvedText)
  return file
}
