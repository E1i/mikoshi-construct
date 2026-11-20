import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { allowRule, declaredCommands } from '../../../src/commands/attach/daemon-commands.js'
import { PROJECT_SETTINGS_FILE, SETTINGS_FILE } from '../../../src/commands/attach/settings.js'

export const SKILLS_DIR = '.claude/skills'
export const SKILL_MANIFEST = 'SKILL.md'
export const ADAPTERS_DIR = '.construct/daemon'
export const ADAPTER_MANIFEST = 'adapter.json'
export const ADAPTER_DAEMON = 'BROWSER_LAB'
export const DAEMON_READER = 'scripts/cli/board-page/daemon-catalog.ts'
export const LOADED_SOURCE = 'the skills of window.heartbeat'
export const DAEMON_KEY = 'daemon'
export const SKETCH_KEY = 'daemon-sketch'
const MUTATION_PREFIX = 'ver_'
const NAME_KEY = 'name'
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const FIELD = /^([\w-]+):(.*)$/

export const WINDOW_SETTINGS_FILES = [PROJECT_SETTINGS_FILE, SETTINGS_FILE] as const

export interface DaemonEntry {
  daemon: string
  skill: string
  sketch: string | null
  mutations: string[]
  commands: string[]
}

export interface Daemon extends DaemonEntry {
  loaded: boolean
  installed: boolean
}

export interface WindowGrants {
  allow: ReadonlySet<string>
  excluded: ReadonlySet<string>
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

export function daemonOf(directory: string, text: string, home: string = homedir()): DaemonEntry | null {
  const fields = manifestFields(text)
  const daemon = fields.get(DAEMON_KEY)
  if (daemon === undefined || daemon === '')
    return null
  const sketch = fields.get(SKETCH_KEY)
  return { daemon, skill: fields.get(NAME_KEY) || directory, sketch: sketch === undefined || sketch === '' ? null : sketch, mutations: [], commands: declaredCommands(text, home) }
}

function settingsLists(text: string | null): { allow: unknown[], excluded: unknown[] } {
  try {
    const settings: unknown = JSON.parse(text ?? '')
    if (typeof settings !== 'object' || settings === null)
      return { allow: [], excluded: [] }
    const { permissions, sandbox } = settings as { permissions?: { allow?: unknown }, sandbox?: { excludedCommands?: unknown } }
    return { allow: Array.isArray(permissions?.allow) ? permissions.allow : [], excluded: Array.isArray(sandbox?.excludedCommands) ? sandbox.excludedCommands : [] }
  }
  catch {
    return { allow: [], excluded: [] }
  }
}

export function windowGrants(root: string, home: string = homedir(), files: CatalogFiles = DISK_CATALOG): WindowGrants {
  const read = [...WINDOW_SETTINGS_FILES.map(file => path.join(root, file)), path.join(home, PROJECT_SETTINGS_FILE)].map(file => settingsLists(files.read(file)))
  return { allow: new Set(read.flatMap(lists => lists.allow).filter(rule => typeof rule === 'string')), excluded: new Set(read.flatMap(lists => lists.excluded).filter(command => typeof command === 'string')) }
}

export function grantsEvery(grants: WindowGrants, commands: readonly string[]): boolean {
  return commands.every(command => grants.allow.has(allowRule(command)) && grants.excluded.has(command))
}

export function adapterMutations(root: string, files: CatalogFiles = DISK_CATALOG): string[] {
  const adapters = path.join(root, ADAPTERS_DIR)
  const present = files.list(adapters).filter(name => files.read(path.join(adapters, name, ADAPTER_MANIFEST)) !== null)
  return present.sort().map(name => `${MUTATION_PREFIX}${name}`)
}

export function daemonCatalog(root: string, files: CatalogFiles = DISK_CATALOG, home: string = homedir()): DaemonEntry[] {
  const skills = path.join(root, SKILLS_DIR)
  const mutations = adapterMutations(root, files)
  return files.list(skills).sort().flatMap((directory) => {
    const text = files.read(path.join(skills, directory, SKILL_MANIFEST))
    const entry = text === null ? null : daemonOf(directory, text, home)
    if (entry === null)
      return []
    return [entry.daemon === ADAPTER_DAEMON ? { ...entry, mutations } : entry]
  })
}

export function installedDaemons(catalog: readonly DaemonEntry[], loadedSkills: readonly string[], grants: WindowGrants): Daemon[] {
  const loaded = new Set(loadedSkills)
  return catalog.map(entry => ({ ...entry, loaded: loaded.has(entry.skill), installed: grantsEvery(grants, entry.commands) }))
}
