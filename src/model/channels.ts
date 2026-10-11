import type { ModuleReading } from './scan.js'
import type { LineSource, Relation } from './schema.js'

export interface ReadModule {
  path: string
  reading: ModuleReading
}

export type ResolveImport = (from: string, specifier: string) => string | null

function constantsByModule(modules: ReadModule[]): Map<string, Map<string, string>> {
  return new Map(modules.map(module => [module.path, new Map(module.reading.fileConstants.map(constant => [constant.binding, constant.name]))]))
}

function namesOf(module: ReadModule, constants: Map<string, Map<string, string>>, resolveImport: ResolveImport): Map<string, number> {
  const named = new Map<string, number>()
  const add = (name: string, line: number): void => {
    if (!named.has(name) || named.get(name)! > line)
      named.set(name, line)
  }
  module.reading.files.forEach(file => add(file.name, file.line))
  for (const entry of module.reading.imports) {
    const target = resolveImport(module.path, entry.specifier)
    const exported = target == null ? undefined : constants.get(target)
    for (const binding of entry.bindings) {
      const name = exported?.get(binding)
      if (name !== undefined)
        add(name, entry.line)
    }
  }
  return named
}

function sides(modules: ReadModule[], resolveImport: ResolveImport): Map<string, { writers: LineSource[], readers: LineSource[] }> {
  const constants = constantsByModule(modules)
  const byName = new Map<string, { writers: LineSource[], readers: LineSource[] }>()
  for (const module of modules) {
    const writes = module.reading.access.some(entry => entry.access === 'writes')
    const reads = module.reading.access.some(entry => entry.access === 'reads')
    if (!writes && !reads)
      continue
    for (const [name, line] of namesOf(module, constants, resolveImport)) {
      const side = byName.get(name) ?? { writers: [], readers: [] }
      if (writes)
        side.writers.push({ path: module.path, line })
      if (reads)
        side.readers.push({ path: module.path, line })
      byName.set(name, side)
    }
  }
  return byName
}

export function fileChannels(modules: ReadModule[], resolveImport: ResolveImport): Relation[] {
  const relations: Relation[] = []
  for (const [name, { writers, readers }] of sides(modules, resolveImport)) {
    for (const writer of writers) {
      for (const reader of readers.filter(candidate => candidate.path !== writer.path)) {
        relations.push({ from: writer.path, to: reader.path, kind: 'writes', specifier: name, status: 'found', source: writer })
        relations.push({ from: reader.path, to: writer.path, kind: 'reads', specifier: name, status: 'found', source: reader })
      }
    }
  }
  return relations
}
