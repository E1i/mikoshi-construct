import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')

const MODULES_FILE = 'scripts/contract/factory/modules.ts'
const SUPERVISOR_FILE = 'scripts/supervisor/supervisor.ts'

const SUPERVISOR_ROOTS = ['supervisor/run.ts', 'supervisor/review-bg.ts', 'supervisor/supervisor.ts', 'supervisor/reducer-thread.ts', 'supervisor/launchd/install.ts'] as const

const MOVED_TO_SESSION = ['signal', 'stillSilent'] as const

function textOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function statementOf(text: string, opening: RegExp): string {
  const found = opening.exec(text)
  if (found === null)
    return ''
  const rest = text.slice(found.index)
  const firstLine = rest.slice(0, rest.indexOf('\n'))
  return firstLine.trimEnd().endsWith(']') ? firstLine : rest.slice(0, rest.indexOf('\n]'))
}

function supervisorHelperNames(statement: string): string[] {
  const call = /\.\.\.supervisor\(([^)]*)\)/.exec(statement)
  return call === null ? [] : [...call[1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

function declares(text: string, name: string): boolean {
  return new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`, 'm').test(text)
    || new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`, 'm').test(text)
    || new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, 'm').test(text)
}

describe('the supervisor processes are composition roots and supervisor.ts declares neither signal nor stillSilent', () => {
  const modules = textOf(MODULES_FILE)

  it('the COMPOSITION_ROOTS array names every supervisor process root as a full path', () => {
    const roots = statementOf(modules, /export const COMPOSITION_ROOTS\b/)
    expect(roots, 'COMPOSITION_ROOTS is in modules.ts').not.toBe('')
    for (const root of SUPERVISOR_ROOTS)
      expect(roots, `COMPOSITION_ROOTS names factory('${root}')`).toContain(`factory('${root}')`)
  })

  it('the session contract no longer lists supervisor among its supervisor helpers', () => {
    const contract = statementOf(modules, /const SESSION_CONTRACT\b/)
    const helpers = supervisorHelperNames(contract)
    expect(helpers, 'SESSION_CONTRACT lists supervisor helpers').not.toEqual([])
    expect(helpers).not.toContain('supervisor')
  })

  it('supervisor.ts declares neither signal nor stillSilent', () => {
    const supervisor = textOf(SUPERVISOR_FILE)
    for (const name of MOVED_TO_SESSION)
      expect(declares(supervisor, name), `${SUPERVISOR_FILE} declares ${name}`).toBe(false)
  })
})
