import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const OWNED = JSON.parse(readFileSync(path.join(ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const BUS_FILES = new Set(OWNED.bus)
const BUS_CONTRACT = 'scripts/core/bus-contract.ts'
const BUS_ADAPTER = 'scripts/core/bus-adapter.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const LEASE = 'scripts/core/lease.ts'
const MERGE_EXECUTOR = 'scripts/nodes/merge/merge-executor.ts'
const ORDER = 'scripts/core/order/turn.ts'
const BUS_TICK = 'scripts/supervisor/run.ts'
const TAKE_THE_CONTRACT_TYPE = [MERGE_EXECUTOR, ORDER]
const LEASE_OPERATIONS = ['assertHeld', 'completeTask', 'waitTask', 'failTask', 'releaseTask', 'StaleLease']

function relativeImportsOf(file: string): string[] {
  const { importedFiles } = ts.preProcessFile(readFileSync(path.join(ROOT, file), 'utf8'), true, true)
  return importedFiles
    .map(imported => imported.fileName)
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier => path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts'))
    .filter(target => existsSync(path.join(ROOT, target)))
}

function reachedFrom(seed: string): Set<string> {
  const reached = new Set([seed])
  const frontier = [seed]
  for (let file = frontier.pop(); file !== undefined; file = frontier.pop()) {
    for (const next of relativeImportsOf(file).filter(each => !reached.has(each))) {
      reached.add(next)
      frontier.push(next)
    }
  }
  return reached
}

function importedNamesFrom(file: string, target: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest)
  return source.statements
    .filter(ts.isImportDeclaration)
    .filter(each => ts.isStringLiteral(each.moduleSpecifier) && path.posix.join(path.posix.dirname(file), each.moduleSpecifier.text).replace(/\.js$/, '.ts') === target)
    .flatMap(each => each.importClause?.namedBindings !== undefined && ts.isNamedImports(each.importClause.namedBindings) ? each.importClause.namedBindings.elements.map(element => element.name.text) : [])
}

describe('merge executor, bus tick, lease and order reach the bus only through the injected contract', () => {
  it.each([MERGE_EXECUTOR, ORDER, BUS_TICK])('%s imports no bus file', (file) => {
    expect(relativeImportsOf(file).filter(each => BUS_FILES.has(each))).toEqual([])
  })

  it.each(TAKE_THE_CONTRACT_TYPE)('%s takes the bus contract type', (file) => {
    expect(relativeImportsOf(file)).toContain(BUS_CONTRACT)
  })

  it('the bus tick takes the contract from the composition root', () => {
    expect(importedNamesFrom(BUS_TICK, COMPOSITION)).toContain('busContract')
  })

  it('the lease stays a bus file, reached through the adapter, and takes its lease shape from the contract', () => {
    expect(BUS_FILES.has(LEASE)).toBe(true)
    expect(importedNamesFrom(BUS_ADAPTER, LEASE)).toEqual(expect.arrayContaining(LEASE_OPERATIONS))
    expect(relativeImportsOf(LEASE)).toContain(BUS_CONTRACT)
  })

  it('the bus contract type reaches no bus file', () => {
    expect([...reachedFrom(BUS_CONTRACT)].filter(each => BUS_FILES.has(each))).toEqual([])
  })
})
