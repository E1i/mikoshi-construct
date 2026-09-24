import type { Dirent } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'

function isGitDirectory(entry: Dirent): boolean {
  return entry.name === '.git' && entry.isDirectory()
}

export function listing(dir: string): string[] {
  const top = readdirSync(dir, { withFileTypes: true }).filter(entry => !isGitDirectory(entry))
  const below = top
    .filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(path.join(dir, entry.name), { recursive: true, withFileTypes: true }))
  return [...top, ...below]
    .map(entry => `${path.relative(dir, path.join(entry.parentPath, entry.name))}${entry.isDirectory() ? '/' : ''}`)
    .sort()
}
