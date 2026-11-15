import type { Linter } from 'eslint'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { COMPOSITION_ROOT, REGISTRATION_LISTS, IMPORT_TIME_REGISTRY_WRITES, REGISTRATION_POLICY } = await import(CONFIG_URL) as {
  COMPOSITION_ROOT: string
  REGISTRATION_LISTS: string[]
  IMPORT_TIME_REGISTRY_WRITES: string[]
  REGISTRATION_POLICY: Linter.Config[]
}

const SOURCE_PROBE = 'scripts/core/registration-probe.ts'
const TEST_PROBE = 'scripts/tests/core/registration-probe.test.ts'
const CLI_PROBE = 'src/registration-probe.ts'
const LINTED = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const WHOLE_TREE_MS = 300_000

const eslint = new ESLint({ cwd: REPO_ROOT })

interface AstNode {
  type: string
  [key: string]: unknown
}

async function parserFor(file: string): Promise<{ parseForESLint: (code: string, options: object) => { ast: AstNode } }> {
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, file)) as { languageOptions: { parser: { parseForESLint: (code: string, options: object) => { ast: AstNode } } } }
  return config.languageOptions.parser
}

function nodesOf(node: unknown): AstNode[] {
  if (node === null || typeof node !== 'object')
    return []
  if (Array.isArray(node))
    return node.flatMap(nodesOf)
  const ast = node as AstNode
  const children = Object.entries(ast).filter(([key]) => key !== 'parent' && key !== 'loc' && key !== 'range').flatMap(([, value]) => nodesOf(value))
  return typeof ast.type === 'string' ? [ast, ...children] : children
}

async function registrationKindsInComposition(): Promise<string[]> {
  const parser = await parserFor(COMPOSITION_ROOT)
  const { ast } = parser.parseForESLint(readFileSync(path.join(REPO_ROOT, COMPOSITION_ROOT), 'utf8'), { sourceType: 'module', ecmaVersion: 'latest', range: true, loc: true })
  const listed = nodesOf(ast)
    .filter(node => node.type === 'Property' && (node.value as AstNode).type === 'ArrayExpression')
    .map(node => (node.key as { name?: string, value?: string }).name ?? String((node.key as { value?: string }).value))
  return [...new Set(listed)].sort()
}

async function compositionMessages(source: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, file) })
  return result!.messages.map(message => message.ruleId ?? '').filter(rule => rule.startsWith('composition/'))
}

function listedInAFunction(kind: string): string {
  return `export function registered(listed: unknown): Record<string, unknown[]> {\n  return { ${kind}: [listed] }\n}\n`
}

function listedAtImport(kind: string): string {
  return `const LISTED = 1\n\nexport const REGISTERED = { ${kind}: [LISTED] }\n`
}

function writtenAtImport(method: string): string {
  return `import { REGISTRY } from './registry.js'\n\nREGISTRY.${method}('listed', 1)\n`
}

function writtenToAnExportAtImport(method: string): string {
  return `export const REGISTRY = new Map<string, number>()\n\nREGISTRY.${method}('listed', 1)\n`
}

function collectedByAScript(method: string): string {
  return `const problems = new Map<string, number>()\n\nproblems.${method}('found', 1)\n\nexport const found = problems.size\n`
}

function writtenInAFunction(method: string): string {
  return `export function registry(): Map<string, number> {\n  const registry = new Map<string, number>()\n  registry.${method}('listed', 1)\n  return registry\n}\n`
}

const KINDS = await registrationKindsInComposition()

describe('registration happens only in the composition module', () => {
  it('reads at least the projection lists from the composition module, and the rule names every list it holds', () => {
    expect(KINDS).toEqual(expect.arrayContaining(['folds', 'incremental']))
    expect(KINDS.filter(kind => !REGISTRATION_LISTS.includes(kind))).toEqual([])
  })

  it('a registration at import time outside composition.ts is a lint error, for every registration kind in the code', async () => {
    for (const kind of KINDS) {
      expect(await compositionMessages(listedInAFunction(kind), SOURCE_PROBE), `${kind} in a function of ${SOURCE_PROBE}`).toEqual(['composition/registers-only-in-composition'])
      expect(await compositionMessages(listedAtImport(kind), SOURCE_PROBE), `${kind} at import in ${SOURCE_PROBE}`).toEqual(['composition/registers-only-in-composition'])
      expect(await compositionMessages(listedAtImport(kind), TEST_PROBE), `${kind} at import in ${TEST_PROBE}`).toEqual(['composition/registers-only-in-composition'])
      expect(await compositionMessages(listedAtImport(kind), CLI_PROBE), `${kind} at import in ${CLI_PROBE}`).toEqual(['composition/registers-only-in-composition'])
    }
    for (const method of IMPORT_TIME_REGISTRY_WRITES) {
      expect(await compositionMessages(writtenAtImport(method), SOURCE_PROBE), `${method} on an import at import`).toEqual(['composition/registers-only-in-composition'])
      expect(await compositionMessages(writtenToAnExportAtImport(method), SOURCE_PROBE), `${method} on an export at import`).toEqual(['composition/registers-only-in-composition'])
      expect(await compositionMessages(writtenAtImport(method), TEST_PROBE), `${method} on an import at import in a test`).toEqual(['composition/registers-only-in-composition'])
    }
    expect(await compositionMessages('import { registerFold } from \'./reducer.js\'\n\nregisterFold(\'listed\')\n', SOURCE_PROBE)).toEqual(['composition/registers-only-in-composition'])
  })

  it('the same registration inside composition.ts passes lint', async () => {
    for (const kind of KINDS) {
      expect(await compositionMessages(listedInAFunction(kind), COMPOSITION_ROOT), `${kind} in a function`).toEqual([])
      expect(await compositionMessages(listedAtImport(kind), COMPOSITION_ROOT), `${kind} as a constant`).toEqual([])
    }
  })

  it('a test may assemble its own projections inside a test body, and a function may fill a map it built', async () => {
    for (const kind of KINDS)
      expect(await compositionMessages(listedInAFunction(kind), TEST_PROBE)).toEqual([])
    for (const method of IMPORT_TIME_REGISTRY_WRITES) {
      expect(await compositionMessages(writtenInAFunction(method), SOURCE_PROBE), method).toEqual([])
      expect(await compositionMessages(collectedByAScript(method), SOURCE_PROBE), `${method} into a script's own collection`).toEqual([])
    }
  })

  it('composition.ts has no side effects on import', async () => {
    expect(await compositionMessages(readFileSync(path.join(REPO_ROOT, COMPOSITION_ROOT), 'utf8'), COMPOSITION_ROOT)).toEqual([])
    for (const method of IMPORT_TIME_REGISTRY_WRITES)
      expect(await compositionMessages(writtenAtImport(method), COMPOSITION_ROOT), method).toEqual(['composition/no-side-effects-on-import'])
    expect(await compositionMessages('import \'./heartbeat.js\'\n\nexport const quiet = 1\n', COMPOSITION_ROOT)).toEqual(['composition/no-side-effects-on-import'])
    expect(await compositionMessages('export const started = Date.now()\n', COMPOSITION_ROOT)).toEqual(['composition/no-side-effects-on-import'])
    expect(await compositionMessages('export const later = (): number => Date.now()\n', COMPOSITION_ROOT)).toEqual([])
  })

  it('on main the rule without exceptions reports nothing beyond the listed moves', async () => {
    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(file => LINTED.test(file))
    const linted: string[] = []
    for (const file of tracked) {
      if (!(await eslint.isPathIgnored(path.join(REPO_ROOT, file))))
        linted.push(file)
    }
    const parser = await parserFor(COMPOSITION_ROOT)
    const policyOnly = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: [{ files: ['**/*.{ts,mts,cts,js,mjs,cjs}'], languageOptions: { parser: parser as Linter.Parser, sourceType: 'module' }, linterOptions: { reportUnusedDisableDirectives: 'off' } }, ...REGISTRATION_POLICY],
    })
    const results = await policyOnly.lintFiles(linted)
    const reported = results.flatMap(result => result.messages
      .filter(message => message.ruleId?.startsWith('composition/') === true || message.fatal === true)
      .map(message => `${path.relative(REPO_ROOT, result.filePath)}:${message.line} ${message.ruleId ?? message.message}`))
    expect(linted.length).toBeGreaterThan(500)
    expect(reported).toEqual([])
  }, WHOLE_TREE_MS)
})
