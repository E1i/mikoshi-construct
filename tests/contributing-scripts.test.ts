import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageScripts } from './package-scripts.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CONTRIBUTING = readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
const SCRIPTS_HEADING = '## Scripts'

function scriptsSection(text: string): string {
  const start = text.indexOf(`\n${SCRIPTS_HEADING}\n`)
  if (start === -1)
    return ''
  const rest = text.slice(start + SCRIPTS_HEADING.length + 2)
  const next = rest.search(/^## /m)
  return next === -1 ? rest : rest.slice(0, next)
}

function describedScripts(section: string): string[] {
  return [...section.matchAll(/^\| `pnpm (?:run )?([\w:-]+)[ `]/gm)].map(match => match[1])
}

describe('the Scripts table in CONTRIBUTING.md describes exactly the scripts package.json defines', () => {
  const described = describedScripts(scriptsSection(CONTRIBUTING))
  const defined = Object.keys(packageScripts())

  it('finds a Scripts table with rows, so the comparison is not over nothing', () => {
    expect(described.length).toBeGreaterThan(3)
  })

  it('has a row for every script in package.json', () => {
    expect(defined.filter(name => !described.includes(name))).toEqual([])
  })

  it('has no row for a script package.json no longer defines', () => {
    expect(described.filter(name => !defined.includes(name))).toEqual([])
  })

  it('has one row per script', () => {
    expect(described.filter((name, at) => described.indexOf(name) !== at)).toEqual([])
  })
})
