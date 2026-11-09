import type { Factory } from '../../scripts/contract/factory.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GLOBAL_FILES, GLOBALS_VERSION, globalsSection } from '../../scripts/contract/factory/globals.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const RECORDED: Factory = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'factory.json'), 'utf8')) as Factory

const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function tree(files: readonly string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'contract-globals-'))
  roots.push(root)
  for (const file of files)
    writeFileSync(path.join(root, file), '')
  return root
}

describe('the globals section of contract/factory.json', () => {
  it('lists the global files sorted, each with why it takes the full run', () => {
    const files = { 'z.json': 'last', 'a.json': 'first' }
    const section = globalsSection(tree(['a.json', 'z.json']), files)
    expect(section).toEqual({ globalsVersion: GLOBALS_VERSION, files: { 'a.json': 'first', 'z.json': 'last' } })
    expect(Object.keys(section.files)).toEqual(['a.json', 'z.json'])
  })

  it('a global file that is not in the repository fails the generation', () => {
    expect(() => globalsSection(tree(['a.json']), { 'a.json': 'here', 'gone.json': 'missing' })).toThrow(/not in the repository: gone\.json$/)
  })

  it('records exactly the global files the generator declares', () => {
    expect(RECORDED.globals).toEqual(globalsSection(REPO_ROOT, GLOBAL_FILES))
  })
})
