import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export class MissingSnapshotFileError extends Error {}

export interface WindowRow {
  window: string
  tree: string
  state: string
}

export interface PolicyRow {
  policy: string
  value: string
}

export interface OpenPr {
  number: number
  title: string
  runsAwaitingApproval: boolean
  files: string[]
}

export interface OwnerMergeKind {
  kind: string
  globs: string[]
  title: string | null
  notChecked: boolean
}

export interface TaskFile {
  id: string
  kind: 'issue' | 'brief'
  fileName: string
  filePath: string
  text: string
}

function readRequired(dir: string, name: string): string {
  const filePath = path.join(dir, name)
  try {
    return readFileSync(filePath, 'utf8')
  }
  catch {
    throw new MissingSnapshotFileError(`cannot read ${name} in ${dir}`)
  }
}

function tableRows(text: string, headerStart: string): string[][] {
  const lines = text.split('\n')
  const headerIndex = lines.findIndex(line => line.trim().startsWith(headerStart))
  if (headerIndex === -1)
    return []
  const rows: string[][] = []
  for (let index = headerIndex + 2; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (!line.startsWith('|'))
      break
    rows.push(line.split('|').slice(1, -1).map(cell => cell.trim()))
  }
  return rows
}

export function readWindowRows(statusText: string): WindowRow[] {
  return tableRows(statusText, '| window |').map(cells => ({
    window: cells[0] ?? '',
    tree: cells[1] ?? '',
    state: cells[2] ?? '',
  }))
}

export function readPolicyRows(statusText: string): PolicyRow[] {
  return tableRows(statusText, '| policy |').map(cells => ({
    policy: cells[0] ?? '',
    value: cells[1] ?? '',
  }))
}

const TITLE_MATCH = /matched by title:\s*«([^»]+)»/
const NOT_CHECKED_MATCH = /not checked by paths/

export function readOwnerMergeKinds(ownerMergesText: string): OwnerMergeKind[] {
  return tableRows(ownerMergesText, '| kind |').map((cells) => {
    const kind = cells[0] ?? ''
    const cell = cells[1] ?? ''
    const titleMatch = TITLE_MATCH.exec(cell)
    if (titleMatch)
      return { kind, globs: [], title: titleMatch[1]!, notChecked: false }
    if (NOT_CHECKED_MATCH.test(cell))
      return { kind, globs: [], title: null, notChecked: true }
    const globs = [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]!)
    return { kind, globs, title: null, notChecked: false }
  })
}

export const GHOSTS_FILES = 'architecture/ghosts-files.md'
export const GHOSTS_FILE_KINDS = ['ghosts', 'plain'] as const

export type GhostsFileKind = typeof GHOSTS_FILE_KINDS[number]

export interface GhostsFile {
  file: string
  kind: GhostsFileKind
}

function ghostsFileKind(value: string): GhostsFileKind | null {
  return (GHOSTS_FILE_KINDS as readonly string[]).includes(value) ? value as GhostsFileKind : null
}

export function readGhostsFiles(ghostsFilesText: string): GhostsFile[] {
  return tableRows(ghostsFilesText, '| file |').flatMap((cells) => {
    const file = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1]
    const kind = ghostsFileKind(cells[1] ?? '')
    return file === undefined || kind === null ? [] : [{ file, kind }]
  })
}

const DECLARED_KIND = /^(\S+) \((\w+)\)$/

export function declaredGhostsFile(createsEntry: string): GhostsFile | null {
  const found = DECLARED_KIND.exec(createsEntry.trim())
  const kind = found === null ? null : ghostsFileKind(found[2]!)
  return found === null || kind === null ? null : { file: found[1]!, kind }
}

const TASK_FILE_NAME = /^\d+-(.+)\.(issue|brief)\.md$/

export function readTaskFiles(dir: string): TaskFile[] {
  const tasksDir = path.join(dir, 'tasks')
  let entries: string[]
  try {
    entries = readdirSync(tasksDir)
  }
  catch {
    throw new MissingSnapshotFileError(`cannot read tasks in ${dir}`)
  }
  return entries
    .filter(name => TASK_FILE_NAME.test(name))
    .sort()
    .map((fileName) => {
      const match = TASK_FILE_NAME.exec(fileName)!
      const filePath = path.join(tasksDir, fileName)
      return {
        id: match[1]!,
        kind: match[2] as 'issue' | 'brief',
        fileName,
        filePath,
        text: readFileSync(filePath, 'utf8'),
      }
    })
}

export interface Snapshot {
  files: string[]
  windows: WindowRow[]
  policies: PolicyRow[]
  ownerMergeKinds: OwnerMergeKind[]
  openPrs: OpenPr[]
  tasks: TaskFile[]
}

export function readSnapshot(dir: string): Snapshot {
  const statusText = readRequired(dir, 'status.md')
  const ownerMergesText = readRequired(dir, 'owner-merges.md')
  const filesText = readRequired(dir, 'files.txt')
  const openPrsText = readRequired(dir, 'open-prs.json')
  return {
    files: filesText.split('\n').map(line => line.trim()).filter(line => line !== ''),
    windows: readWindowRows(statusText),
    policies: readPolicyRows(statusText),
    ownerMergeKinds: readOwnerMergeKinds(ownerMergesText),
    openPrs: JSON.parse(openPrsText) as OpenPr[],
    tasks: readTaskFiles(dir),
  }
}
