import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { eachNode, parsedFiles } from '../../scripts/contract/factory/walk.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const PORTS = 'scripts/ports/'
const ADAPTER_MODULE = 'scripts/ports/client/claude/adapter.ts'
const SHIFT_SETTINGS = 'scripts/ports/shift-settings.ts'
const SESSION_PORT = 'scripts/ports/session.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const ADAPTER_BUILDER = 'claudeAdapterWith'
const ENTRY_GUARD = /process\.argv\[1\] !== undefined && realpathSync\(process\.argv\[1\]\) === /

const SCANNED = parsedFiles(REPO_ROOT, ['scripts'])

function callsTheBuilder(source: ts.SourceFile): boolean {
  let calls = false
  eachNode(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === ADAPTER_BUILDER)
      calls = true
  })
  return calls
}

function importsOf(file: string, source: ts.SourceFile): string[] {
  return source.statements
    .filter(ts.isImportDeclaration)
    .map(statement => (statement.moduleSpecifier as ts.StringLiteral).text)
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/, '.ts'))
}

function packageScriptEntries(): string[] {
  const scripts = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  return Object.values(scripts).flatMap(command => command.match(/scripts\/[\w/.-]+\.ts/g) ?? [])
}

function isProcessRoot(file: string, source: ts.SourceFile, entries: readonly string[]): boolean {
  return file === COMPOSITION || ENTRY_GUARD.test(source.text) || entries.includes(file)
}

function topLevelAdapterHolders(source: ts.SourceFile): string[] {
  return source.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .filter(declaration => /ClientAdapter/.test(declaration.type?.getText(source) ?? '') || /claudeAdapterWith|ClientAdapter/.test(declaration.initializer?.getText(source) ?? ''))
    .map(declaration => declaration.name.getText(source))
}

describe('the client adapter is built at the process roots and handed down', () => {
  it('no file under scripts/ports/ calls claudeAdapterWith or imports scripts/ports/shift-settings.ts', () => {
    const ports = SCANNED.filter(({ file }) => file.startsWith(PORTS) && file !== SHIFT_SETTINGS)
    expect(ports.length).toBeGreaterThan(0)
    expect(ports.filter(({ source }) => callsTheBuilder(source)).map(({ file }) => file)).toEqual([])
    expect(ports.filter(({ file, source }) => importsOf(file, source).includes(SHIFT_SETTINGS)).map(({ file }) => file)).toEqual([])
  })

  it('scripts/ports/session.ts holds no module-level client adapter', () => {
    const session = SCANNED.find(({ file }) => file === SESSION_PORT)
    expect(session).toBeDefined()
    expect(topLevelAdapterHolders(session!.source)).toEqual([])
    expect(session!.source.text).not.toContain(ADAPTER_BUILDER)
  })

  it('every claudeAdapterWith call outside tests is in a process root', () => {
    const entries = packageScriptEntries()
    const builders = SCANNED.filter(({ file, source }) => file !== ADAPTER_MODULE && callsTheBuilder(source))
    expect(builders.map(({ file }) => file)).toContain(COMPOSITION)
    expect(builders.filter(({ file, source }) => !isProcessRoot(file, source, entries)).map(({ file }) => file)).toEqual([])
  })
})
