import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')

const MODULES_FILE = 'scripts/contract/factory/modules.ts'

function statementOf(text: string, opening: RegExp): string {
  const found = opening.exec(text)
  if (found === null)
    return ''
  const rest = text.slice(found.index)
  const firstLine = rest.slice(0, rest.indexOf('\n'))
  return firstLine.trimEnd().endsWith(']') ? firstLine : rest.slice(0, rest.indexOf('\n]'))
}

describe('ports/netwatch.ts is a composition root and out of the ports contract', () => {
  const modules = readFileSync(path.join(REPO_ROOT, MODULES_FILE), 'utf8')

  it('the COMPOSITION_ROOTS array names ports/netwatch.ts as a full path', () => {
    const roots = statementOf(modules, /export const COMPOSITION_ROOTS\b/)
    expect(roots, 'COMPOSITION_ROOTS is in modules.ts').not.toBe('')
    expect(roots).toContain(`factory('ports/netwatch.ts')`)
  })

  it('the PORTS_CONTRACT array no longer names netwatch.ts', () => {
    const contract = statementOf(modules, /const PORTS_CONTRACT\b/)
    expect(contract, 'PORTS_CONTRACT is in modules.ts').not.toBe('')
    expect(contract).not.toContain('netwatch.ts')
  })
})
