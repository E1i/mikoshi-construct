import { escaped } from '../model/page.js'

export const FILE_LEAF_LIMIT = 8

interface Folder {
  name: string
  files: string[]
  folders: Map<string, Folder>
}

function folder(name: string): Folder {
  return { name, files: [], folders: new Map() }
}

function countOf(entry: Folder): number {
  return [...entry.folders.values()].reduce((total, child) => total + countOf(child), entry.files.length)
}

function compressed(entry: Folder): Folder {
  if (entry.files.length === 0 && entry.folders.size === 1) {
    const only = [...entry.folders.values()][0]!
    return compressed({ ...only, name: `${entry.name}/${only.name}` })
  }
  return entry
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function leaves(files: string[]): string {
  if (files.length > FILE_LEAF_LIMIT)
    return `<li class="empty">${files.length} files directly here</li>`
  return files.sort(compare).map(file => `<li>${escaped(file)}</li>`).join('')
}

function folderItems(entry: Folder): string {
  const folders = [...entry.folders.values()].map(compressed).sort((left, right) => compare(left.name, right.name))
  return folders.map(child => `<li><details><summary>${escaped(child.name)}/ (${countOf(child)})</summary><ul class="tree">${folderItems(child)}</ul></details></li>`).join('') + leaves(entry.files)
}

export function folderTree(paths: readonly string[]): string {
  const root = folder('')
  for (const file of paths) {
    const segments = file.split('/')
    let at = root
    for (const segment of segments.slice(0, -1)) {
      if (!at.folders.has(segment))
        at.folders.set(segment, folder(segment))
      at = at.folders.get(segment)!
    }
    at.files.push(segments.at(-1)!)
  }
  return `<ul class="tree">${folderItems(root)}</ul>`
}
