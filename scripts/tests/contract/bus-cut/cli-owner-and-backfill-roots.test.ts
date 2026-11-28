import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')

const MODULES_FILE = 'scripts/contract/factory/modules.ts'
const MODULE_DECLARATIONS = 'declarations/modules'
const NEW_ROOTS = ['cli/card.ts', 'cli/mutate.ts', 'owner/session.ts'] as const
const UNDECLARED = ['scripts/cli/card.ts', 'scripts/cli/mutate.ts'] as const

function statementOf(text: string, opening: RegExp): string {
  const found = opening.exec(text)
  if (found === null)
    return ''
  const rest = text.slice(found.index)
  const firstLine = rest.slice(0, rest.indexOf('\n'))
  return firstLine.trimEnd().endsWith(']') ? firstLine : rest.slice(0, rest.indexOf('\n]'))
}

function declaredPaths(): { module: string, paths: string[] }[] {
  const folder = path.join(REPO_ROOT, MODULE_DECLARATIONS)
  return readdirSync(folder).filter(name => name.endsWith('.json')).map((name) => {
    const value = JSON.parse(readFileSync(path.join(folder, name), 'utf8')) as { module: string, paths: string[] }
    return { module: value.module, paths: value.paths }
  })
}

describe('cli/card.ts, cli/mutate.ts and owner/session.ts are composition roots and no module declares the two cli files', () => {
  const modules = readFileSync(path.join(REPO_ROOT, MODULES_FILE), 'utf8')

  it.each(NEW_ROOTS)('the COMPOSITION_ROOTS array names %s as a full path', (root) => {
    const roots = statementOf(modules, /export const COMPOSITION_ROOTS\b/)
    expect(roots, 'COMPOSITION_ROOTS is in modules.ts').not.toBe('')
    expect(roots).toContain(`factory('${root}')`)
  })

  it.each(UNDECLARED)('no declarations/modules/*.json lists %s in its paths', (file) => {
    const declarations = declaredPaths()
    expect(declarations.length, 'the module declarations are read').toBeGreaterThan(0)
    expect(declarations.filter(declaration => declaration.paths.includes(file)).map(declaration => declaration.module)).toEqual([])
  })
})
