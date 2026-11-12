import type { ModuleGraphSpec } from '../factory/modules.js'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { CARVED_OUT, heldBy, isTool, matchesGlob, SOURCE_TREES } from '../factory/modules.js'

const COMPOSITION_ROOT = 'composition root'

export type OwnershipFault
  = | { kind: 'unowned', file: string }
    | { kind: 'owned-twice', file: string, holders: string[] }
    | { kind: 'contract-outside-owns', module: string, glob: string }
    | { kind: 'glob-matches-nothing', holder: string, glob: string }
    | { kind: 'unknown-may-use', module: string, target: string }

export function sourceFiles(root: string, trees: readonly string[] = SOURCE_TREES): string[] {
  return trees
    .flatMap(tree => readdirSync(path.join(root, tree), { withFileTypes: true, recursive: true })
      .filter(entry => entry.isFile())
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')))
    .sort()
}

function holdersOf(spec: ModuleGraphSpec): [string, readonly string[]][] {
  return [
    ...Object.entries(spec.modules).map(([id, { owns }]): [string, readonly string[]] => [id, owns]),
    [COMPOSITION_ROOT, spec.composition_roots],
    ...Object.entries(spec.exclusions).map(([kind, globs]): [string, readonly string[]] => [`exclusion:${kind}`, globs]),
  ]
}

export function ownerOf(spec: ModuleGraphSpec, file: string): string[] {
  return holdersOf(spec).filter(([, globs]) => heldBy(globs, file)).map(([holder]) => holder)
}

function fileFaults(spec: ModuleGraphSpec, files: readonly string[]): OwnershipFault[] {
  return files.flatMap((file): OwnershipFault[] => {
    const holders = ownerOf(spec, file)
    if (holders.length === 0)
      return [{ kind: 'unowned', file }]
    return holders.length > 1 ? [{ kind: 'owned-twice', file, holders }] : []
  })
}

function staleGlobs(spec: ModuleGraphSpec, files: readonly string[]): OwnershipFault[] {
  return holdersOf(spec).flatMap(([holder, globs]) => globs
    .filter(glob => !glob.startsWith(CARVED_OUT) && !files.some(file => matchesGlob(glob, file)))
    .map((glob): OwnershipFault => ({ kind: 'glob-matches-nothing', holder, glob })))
}

function contractFaults(spec: ModuleGraphSpec, files: readonly string[]): OwnershipFault[] {
  return Object.entries(spec.modules).flatMap(([module, { owns, contract }]) => contract
    .filter((glob) => {
      const covered = files.filter(file => matchesGlob(glob, file))
      return covered.length === 0 || covered.some(file => !heldBy(owns, file))
    })
    .map((glob): OwnershipFault => ({ kind: 'contract-outside-owns', module, glob })))
}

function mayUseFaults(spec: ModuleGraphSpec): OwnershipFault[] {
  return Object.entries(spec.modules).flatMap(([module, { may_use }]) => may_use
    .filter(target => target === module || spec.modules[target] === undefined || isTool(spec.modules[target]))
    .map((target): OwnershipFault => ({ kind: 'unknown-may-use', module, target })))
}

export function ownershipFaults(spec: ModuleGraphSpec, files: readonly string[]): OwnershipFault[] {
  return [...fileFaults(spec, files), ...staleGlobs(spec, files), ...contractFaults(spec, files), ...mayUseFaults(spec)]
}

export function faultLine(fault: OwnershipFault): string {
  switch (fault.kind) {
    case 'unowned':
      return `${fault.file}: in no module and no exclusion`
    case 'owned-twice':
      return `${fault.file}: held by ${fault.holders.join(', ')}`
    case 'contract-outside-owns':
      return `${fault.module}: contract ${fault.glob} is not inside its owns`
    case 'glob-matches-nothing':
      return `${fault.holder}: ${fault.glob} matches no file`
    case 'unknown-may-use':
      return `${fault.module}: may_use names ${fault.target}, which is not another module`
  }
}
