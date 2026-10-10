import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../src/program.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function discoveryBlock(name: string): string {
  const agents = read('AGENTS.md')
  const opens = agents.indexOf(`<!-- construct:discover:${name} -->`)
  const closes = agents.indexOf(`<!-- /construct:discover:${name} -->`)
  expect(opens, `AGENTS.md has no ${name} block`).toBeGreaterThan(-1)
  expect(closes).toBeGreaterThan(opens)
  return agents.slice(opens, closes)
}

function programCommands(): string[] {
  return Object.keys(main.subCommands as Record<string, unknown>)
}

function allowedImportModules(): string[] {
  const config = read('eslint.config.mjs')
  const opens = config.indexOf('const ALLOWED_INTERNAL_IMPORTS = {')
  const body = config.slice(opens, config.indexOf('\n}\n', opens))
  return [...body.matchAll(/^\s+'src\/([\w-]+)(?:\.ts)?':/gm)].map(match => match[1])
}

describe('the always-loaded AGENTS.md names what the code defines', () => {
  it('reads the commands from src/program.ts and the modules from eslint.config.mjs', () => {
    expect(programCommands()).toEqual(expect.arrayContaining(['init', 'sync', 'mutate', 'jack-in']))
    expect(allowedImportModules()).toEqual(expect.arrayContaining(['atlas', 'card', 'known-flags', 'failure', 'manifest', 'cli']))
  })

  for (const command of programCommands()) {
    it(`names the command \`${command}\` among the composition roots`, () => {
      expect(discoveryBlock('composition-roots')).toContain(`\`${command}\``)
    })
  }

  for (const module of allowedImportModules()) {
    it(`names the module \`${module}\` in the dependency policy`, () => {
      expect(discoveryBlock('dependency-policy')).toContain(`\`${module}\``)
    })
  }
})
