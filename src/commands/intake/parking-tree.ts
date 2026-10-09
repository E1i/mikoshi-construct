import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  }
  catch {
    return false
  }
}

export function parkingTree(dir: string): string[] {
  if (!isDirectory(dir))
    return []
  const subdirectories = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
  return [dir, ...subdirectories.flatMap(entry => parkingTree(path.join(dir, entry.name)))]
}

export function isWithin(root: string, dir: string): boolean {
  const relative = path.relative(root, dir)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}
