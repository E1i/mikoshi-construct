import type { ParsedFile } from '../../scripts/contract/factory/walk.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { cardGrammarFiles } from '../../scripts/contract/factory/card.js'
import { boundarySection, namesImportedAcross } from '../../scripts/contract/factory/ports.js'
import { parsedFiles } from '../../scripts/contract/factory/walk.js'
import { EVENT_PAYLOADS, RESTART_MISSED } from '../../scripts/core/events.js'
import { RESTART_MISSED as INBOX_RESTART_MISSED } from '../../scripts/core/inbox.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const RECORDED = path.join(REPO_ROOT, 'contract', 'factory.json')
const SOURCE_SUFFIX = /\.js$/
const LABEL_CONSTANT = /^(?:export )?const [A-Z_]+_(?:PREFIX|HEADER|HEADING|FIELD) = '([A-Z]?[a-z]+(?:,? [a-z]+)*): ?'$/gm
const LABELLED_LINE = /^(?:export )?const [A-Z_]+ = \/\^\(?([a-z|]+)\)?:/gm
const VERDICT_NOT_FIELD = 'exit:'
const OWNER_NAMED_FIELDS = ['tools:', 'corrected:', 'whole:', 'import:', 'ladder:', 'layer:', 'Owner, verbatim:']
const DRAFT_FIELDS = ['draft.whole', 'draft.item', 'draft.number', 'draft.task', 'draft.plan.id', 'draft.plan.title', 'draft.plan.goal', 'draft.plan.file']

interface PortModule {
  functions: Record<string, string>
  types: Record<string, string>
  constants: string[]
  reexports: string[]
}

interface Recorded {
  ports: { modules: Record<string, PortModule>, boundary: Record<string, PortModule> }
  card: { fields: Record<string, string> }
  bus: { events: Record<string, { keys: string[], complete: boolean }> }
}

function recorded(): Recorded {
  return JSON.parse(readFileSync(RECORDED, 'utf8')) as Recorded
}

function parsed(file: string, text: string): ParsedFile {
  return { file, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) }
}

function srcNamesImportedByScripts(): Map<string, Set<string>> {
  const crossing = new Map<string, Set<string>>()
  for (const { file, source } of parsedFiles(REPO_ROOT, ['scripts'])) {
    for (const statement of source.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null
      if (specifier === null || !specifier.startsWith('.'))
        continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(SOURCE_SUFFIX, '.ts')
      if (!target.startsWith('src/'))
        continue
      const names = crossing.get(target) ?? new Set<string>()
      eachImportedName(statement as ts.ImportDeclaration | ts.ExportDeclaration, name => names.add(name))
      crossing.set(target, names)
    }
  }
  return crossing
}

function eachImportedName(statement: ts.ImportDeclaration | ts.ExportDeclaration, add: (name: string) => void): void {
  const node = ts.isImportDeclaration(statement) ? statement.importClause : statement.exportClause
  if (node === undefined)
    return
  if (ts.isImportClause(node) && node.name !== undefined)
    add('default')
  const named = ts.isImportClause(node) ? node.namedBindings : node
  if (named !== undefined && (ts.isNamedImports(named) || ts.isNamedExports(named)))
    named.elements.forEach(element => add((element.propertyName ?? element.name).text))
}

function describedNames(module: PortModule): string[] {
  return [...Object.keys(module.functions), ...Object.keys(module.types), ...module.constants.map(constant => constant.split(':')[0]!), ...module.reexports]
}

function grammarLabels(): Map<string, string> {
  const labels = new Map<string, string>()
  for (const { file, source } of cardGrammarFiles(REPO_ROOT)) {
    const text = source.getFullText()
    for (const [, label] of text.matchAll(LABEL_CONSTANT))
      labels.set(`${label}:`, file)
    for (const [, alternatives] of text.matchAll(LABELLED_LINE))
      alternatives!.split('|').forEach(label => labels.set(`${label}:`, file))
  }
  labels.delete(VERDICT_NOT_FIELD)
  return labels
}

describe('the src to scripts seam and the card body fields in contract/factory.json', () => {
  it('every src export imported by scripts has its entry in contract/factory.json ports', () => {
    const { ports: { boundary } } = recorded()
    const crossing = srcNamesImportedByScripts()

    expect(crossing.size).toBeGreaterThan(0)
    expect(Object.keys(boundary).sort()).toEqual([...crossing.keys()].sort())
    for (const [file, names] of crossing) {
      expect(describedNames(boundary[file]!).sort(), file).toEqual([...names].sort())
      for (const [name, signature] of Object.entries(boundary[file]!.functions))
        expect(signature, `${file} :: ${name}`).toMatch(/^(?:<.*>)?\(/)
    }
  })

  it('an export only src imports, or only scripts imports from scripts, is not described', () => {
    const products = [
      parsed('src/card/seam.ts', 'export function crossing(card: string): number { return card.length }\nexport function internal(): void {}\nexport interface Shape { id: number }\n'),
      parsed('src/card/inner.ts', 'export const ONLY_SRC = 1\n'),
    ]
    const importers = [
      parsed('scripts/core/user.ts', 'import type { Shape } from \'../../src/card/seam.js\'\nimport { crossing } from \'../../src/card/seam.js\'\nimport { local } from \'./local.js\'\n'),
      parsed('src/card/other.ts', 'import { ONLY_SRC } from \'./inner.js\'\nimport { internal } from \'./seam.js\'\n'),
    ]

    expect(boundarySection(products, namesImportedAcross(importers))).toEqual({
      'src/card/seam.ts': { functions: { crossing: '(card: string): number' }, types: { Shape: 'interface Shape { id: number; }' }, constants: [], reexports: [] },
    })
  })

  it('a name scripts imports that src declares by no export the ports section reads refuses generation', () => {
    const products = [parsed('src/card/seam.ts', 'export const PRESENT = 1\n')]
    const importers = [parsed('scripts/core/user.ts', 'import { ABSENT } from \'../../src/card/seam.js\'\n')]

    expect(() => boundarySection(products, namesImportedAcross(importers))).toThrow('src/card/seam.ts :: ABSENT')
  })

  it('every field the card grammar reads from a card body has its entry in contract/factory.json card.fields', () => {
    const { card: { fields } } = recorded()
    const labels = grammarLabels()

    expect([...labels.keys()]).toEqual(expect.arrayContaining(OWNER_NAMED_FIELDS))
    for (const [label, file] of labels)
      expect(fields[label], `${label} read by ${file}`).toContain(file)
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(DRAFT_FIELDS))
    expect(fields[VERDICT_NOT_FIELD]).toBeUndefined()
  })

  it('supervisor.restart_missed is in the event catalogue', () => {
    expect(INBOX_RESTART_MISSED).toBe(RESTART_MISSED)
    expect(EVENT_PAYLOADS[RESTART_MISSED]).toEqual(['limit_ms', 'sha', 'waited_ms'])
    expect(recorded().bus.events[RESTART_MISSED]).toEqual({ keys: ['limit_ms', 'sha', 'waited_ms'], complete: true })
  })
})
