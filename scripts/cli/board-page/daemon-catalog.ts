import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const SKILLS_DIR = '.claude/skills'
export const SKILL_MANIFEST = 'SKILL.md'
export const DAEMON_READER = 'scripts/cli/board-page/daemon-catalog.ts'
export const LOADED_SOURCE = 'the skills of window.heartbeat'
export const DAEMON_KEY = 'daemon'
export const SKETCH_KEY = 'daemon-sketch'
export const MUTATIONS_KEY = 'daemon-mutations'
const NAME_KEY = 'name'
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const FIELD = /^([\w-]+):(.*)$/
const MUTATION = /^ver_\w+$/
const LIST_SPLIT = /[\s,[\]]+/

export interface DaemonEntry {
  daemon: string
  skill: string
  sketch: string | null
  mutations: string[]
}

export interface Daemon extends DaemonEntry {
  loaded: boolean
}

export interface CatalogFiles {
  list: (dir: string) => string[]
  read: (file: string) => string | null
}

export const DISK_CATALOG: CatalogFiles = {
  list: (dir) => {
    try {
      return readdirSync(dir)
    }
    catch {
      return []
    }
  },
  read: (file) => {
    try {
      return readFileSync(file, 'utf8')
    }
    catch {
      return null
    }
  },
}

export function manifestFields(text: string): Map<string, string> {
  const block = FRONTMATTER.exec(text)?.[1] ?? ''
  return new Map(block.split(/\r?\n/).flatMap((line) => {
    const field = FIELD.exec(line)
    return field === null ? [] : [[field[1]!, field[2]!.trim()] as const]
  }))
}

export function daemonOf(directory: string, text: string): DaemonEntry | null {
  const fields = manifestFields(text)
  const daemon = fields.get(DAEMON_KEY)
  if (daemon === undefined || daemon === '')
    return null
  const sketch = fields.get(SKETCH_KEY)
  const mutations = (fields.get(MUTATIONS_KEY) ?? '').split(LIST_SPLIT).filter(word => MUTATION.test(word))
  return { daemon, skill: fields.get(NAME_KEY) || directory, sketch: sketch === undefined || sketch === '' ? null : sketch, mutations }
}

export function daemonCatalog(root: string, files: CatalogFiles = DISK_CATALOG): DaemonEntry[] {
  const skills = path.join(root, SKILLS_DIR)
  return files.list(skills).sort().flatMap((directory) => {
    const text = files.read(path.join(skills, directory, SKILL_MANIFEST))
    const entry = text === null ? null : daemonOf(directory, text)
    return entry === null ? [] : [entry]
  })
}

export function installedDaemons(catalog: readonly DaemonEntry[], loadedSkills: readonly string[]): Daemon[] {
  const loaded = new Set(loadedSkills)
  return catalog.map(entry => ({ ...entry, loaded: loaded.has(entry.skill) }))
}
