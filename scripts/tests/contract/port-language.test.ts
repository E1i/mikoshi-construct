import type { Factory } from '../../contract/factory.js'
import type { PortModule } from '../../contract/factory/ports.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DECLARED_WORDS, PORT_LANGUAGES, portLanguage, technologyVocabulary } from '../../contract/factory.js'
import { portsSection } from '../../contract/factory/ports.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const RECORDED = path.join(REPO_ROOT, 'contract', 'factory.json')
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'contract', 'factory.ts')
const VOCABULARY = new Set(['gh', 'git', 'lsof', 'stdout', 'database'])
const scratchRoots: string[] = []

afterAll(() => scratchRoots.forEach(root => rmSync(root, { recursive: true, force: true })))

function scratchPorts(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'port-language-'))
  scratchRoots.push(root)
  mkdirSync(path.join(root, 'scripts', 'ports'), { recursive: true })
  for (const [file, text] of Object.entries(files))
    writeFileSync(path.join(root, 'scripts', 'ports', file), text)
  return root
}

function port(parts: Partial<PortModule>): PortModule {
  return { functions: {}, types: {}, constants: [], reexports: [], ...parts }
}

describe('the language each port speaks in contract/factory.json', () => {
  it('every port in the contract says whether it speaks the factory or a technology', () => {
    const { ports } = JSON.parse(readFileSync(RECORDED, 'utf8')) as Factory
    const declared = technologyVocabulary()

    expect(Object.keys(ports).length).toBeGreaterThan(0)
    for (const [file, recorded] of Object.entries(ports)) {
      expect(PORT_LANGUAGES, file).toContain(recorded.language)
      expect(Array.isArray(recorded.technologyWords), file).toBe(true)
      expect(recorded.language === 'technology', file).toBe(recorded.technologyWords.length > 0)
      for (const word of recorded.technologyWords)
        expect(declared.has(word), `${file}: ${word}`).toBe(true)
    }
    expect(ports['scripts/ports/git.ts']!.language).toBe('technology')
    expect(ports['scripts/ports/git.ts']!.technologyWords).toEqual(expect.arrayContaining(['git', 'porcelain']))
  })

  it('a new technology word declared only in its adapter marks the port without an edit to factory.ts', () => {
    const root = scratchPorts({
      'frob.ts': `export const ${DECLARED_WORDS} = ['frobnicator'] as const\nexport function readFrobnicator(): string { return '' }\n`,
      'plain.ts': `export function cardTitle(card: number): string { return String(card) }\n`,
    })
    const vocabulary = technologyVocabulary(root)
    const ports = portsSection(root)

    expect(readFileSync(GENERATOR, 'utf8')).not.toContain('frobnicator')
    expect(vocabulary.has('frobnicator')).toBe(true)
    expect(portLanguage(ports['scripts/ports/frob.ts']!, vocabulary)).toMatchObject({ language: 'technology', technologyWords: ['frobnicator'] })
    expect(portLanguage(ports['scripts/ports/plain.ts']!, vocabulary).language).toBe('factory')
  })

  it('the generator keeps no list of technology words: every word but the client id comes from a port', () => {
    const root = scratchPorts({ 'plain.ts': `export function cardTitle(card: number): string { return String(card) }\n` })

    expect(technologyVocabulary(root).size).toBe(1)
    expect(readFileSync(GENERATOR, 'utf8')).not.toMatch(/'(?:bwrap|lsof|porcelain|socat|statfs)'/)
  })

  it('a port whose surface names only factory words speaks the factory', () => {
    const marked = portLanguage(port({ functions: { aliveSession: '(session: string): boolean' }, types: { CardTree: 'interface CardTree { worktree: string; branch: string; }' } }), VOCABULARY)

    expect(marked.language).toBe('factory')
    expect(marked.technologyWords).toEqual([])
  })

  it('a port names the technology it speaks, from function names, signatures, types, constants and reexports alike', () => {
    const cases: Array<[Partial<PortModule>, string]> = [
      [{ functions: { readLsof: '(): string' } }, 'lsof'],
      [{ functions: { rows: '(db: DatabaseSync): number[]' } }, 'database'],
      [{ types: { Reader: 'type Reader = (stdoutPath: string) => string' } }, 'stdout'],
      [{ constants: ['GH_TIMEOUT_SECONDS'] }, 'gh'],
      [{ reexports: ['execGit'] }, 'git'],
      [{ functions: { GHClient: '(): void' } }, 'gh'],
    ]

    for (const [parts, word] of cases) {
      const marked = portLanguage(port(parts), VOCABULARY)

      expect(marked.language, word).toBe('technology')
      expect(marked.technologyWords, word).toContain(word)
    }
  })

  it('a technology word inside a longer factory word does not mark the port', () => {
    const marked = portLanguage(port({ functions: { process: '(steps: string[]): Pipeline' }, types: { Pipeline: 'interface Pipeline { gitless: boolean; }' } }), VOCABULARY)

    expect(marked.language).toBe('factory')
  })
})
