import type { ScriptRegistry } from '../scripts/contract/surface.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requiredChange } from '../scripts/contract/semantic-diff.js'
import { renderScriptsTable, scriptNames, scriptRegistry } from '../scripts/contract/surface.js'
import { fixtureSurface } from './contract/surface-fixture.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CONTRIBUTING = readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
const RECORDED_SURFACE = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/surface.json'), 'utf8')) as { scripts: string[] }
const REGISTRY = scriptRegistry()
const ADDED = 'probe:added'
const REASON = 'a hand-run print | not a gate'

function withAddedScript(): ScriptRegistry {
  return {
    scripts: { ...REGISTRY.scripts, [ADDED]: 'node --import tsx scripts/probe.ts' },
    scriptsOutsideTheHarness: { ...REGISTRY.scriptsOutsideTheHarness, [ADDED]: REASON },
  }
}

function withoutScript(name: string): ScriptRegistry {
  const { [name]: _, ...scripts } = REGISTRY.scripts
  return { ...REGISTRY, scripts }
}

function linesOf(text: string, name: string): string[] {
  return text.split('\n').filter(line => line.startsWith(`| \`pnpm ${name}\``))
}

describe('package.json is the one registry of scripts, and the table and the surface follow it', () => {
  it('a script added to the registry appears in the table and the surface', () => {
    const added = withAddedScript()
    expect(linesOf(renderScriptsTable(CONTRIBUTING, added), ADDED)).toEqual([`| \`pnpm ${ADDED}\` | a hand-run print \\| not a gate | \`pnpm ${ADDED}\` |`])
    expect(scriptNames(added)).toContain(ADDED)
  })

  it('a script with no reason outside the harness gets the row of a script in it', () => {
    const { scriptsOutsideTheHarness: _, ...added } = withAddedScript()
    const table = renderScriptsTable(CONTRIBUTING, { ...added, scriptsOutsideTheHarness: REGISTRY.scriptsOutsideTheHarness })
    expect(linesOf(table, ADDED)).toEqual([`| \`pnpm ${ADDED}\` | In the harness. | \`pnpm ${ADDED}\` |`])
  })

  it('puts the new row inside the table, before the text that follows it', () => {
    const table = renderScriptsTable(CONTRIBUTING, withAddedScript())
    expect(table.indexOf(`\`pnpm ${ADDED}\``)).toBeGreaterThan(table.indexOf('| `pnpm board` |'))
    expect(table.indexOf(`\`pnpm ${ADDED}\``)).toBeLessThan(table.indexOf('`ghosts:hash`:'))
  })

  it('a script gone from the registry loses its row and leaves every other row as it was', () => {
    const gone = renderScriptsTable(CONTRIBUTING, withoutScript('docs:dev'))
    expect(linesOf(gone, 'docs:dev')).toEqual([])
    expect(renderScriptsTable(gone, REGISTRY)).toContain('`pnpm docs:dev`')
    expect(gone.split('\n').length).toBe(CONTRIBUTING.split('\n').length - 1)
  })

  it('finds the table current: rendering the recorded CONTRIBUTING.md changes nothing', () => {
    expect(renderScriptsTable(CONTRIBUTING, REGISTRY)).toBe(CONTRIBUTING)
  })

  it('finds the surface current: it records exactly the names in the registry', () => {
    expect(RECORDED_SURFACE.scripts).toEqual(scriptNames(REGISTRY))
  })

  it('refuses a CONTRIBUTING.md with no table to keep the scripts in', () => {
    expect(() => renderScriptsTable('# Contributing\n', REGISTRY)).toThrow('no rows under')
  })

  it('holds no reason for a script the registry does not define', () => {
    expect(Object.keys(REGISTRY.scriptsOutsideTheHarness).filter(name => !(name in REGISTRY.scripts))).toEqual([])
  })

  it('a script added to the surface asks no bump of the published package', () => {
    const { surfaceVersion: _, ...recorded } = fixtureSurface()
    const withAdded = { ...recorded, scripts: [...recorded.scripts, ADDED] }
    expect(requiredChange(recorded, withAdded).level).toBe('none')
  })
})
