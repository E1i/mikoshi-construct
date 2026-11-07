import type { Factory } from '../../contract/factory.js'
import type { PortModule } from '../../contract/factory/ports.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PORT_LANGUAGES, portLanguage, TECHNOLOGY_WORDS } from '../../contract/factory.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const RECORDED = path.join(REPO_ROOT, 'contract', 'factory.json')

function port(parts: Partial<PortModule>): PortModule {
  return { functions: {}, types: {}, constants: [], reexports: [], ...parts }
}

describe('the language each port speaks in contract/factory.json', () => {
  it('every port in the contract says whether it speaks the factory or a technology', () => {
    const { ports } = JSON.parse(readFileSync(RECORDED, 'utf8')) as Factory

    expect(Object.keys(ports).length).toBeGreaterThan(0)
    for (const [file, recorded] of Object.entries(ports)) {
      expect(PORT_LANGUAGES, file).toContain(recorded.language)
      expect(Array.isArray(recorded.technologyWords), file).toBe(true)
      expect(recorded.language === 'technology', file).toBe(recorded.technologyWords.length > 0)
      for (const word of recorded.technologyWords)
        expect(TECHNOLOGY_WORDS.has(word), `${file}: ${word}`).toBe(true)
    }
    expect(ports['scripts/ports/git.ts']!.language).toBe('technology')
    expect(ports['scripts/ports/git.ts']!.technologyWords).toEqual(expect.arrayContaining(['git', 'porcelain']))
  })

  it('a port whose surface names only factory words speaks the factory', () => {
    const marked = portLanguage(port({ functions: { aliveSession: '(session: string): boolean' }, types: { CardTree: 'interface CardTree { worktree: string; branch: string; }' } }))

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
      const marked = portLanguage(port(parts))

      expect(marked.language, word).toBe('technology')
      expect(marked.technologyWords, word).toContain(word)
    }
  })

  it('a technology word inside a longer factory word does not mark the port', () => {
    const marked = portLanguage(port({ functions: { process: '(steps: string[]): Pipeline' }, types: { Pipeline: 'interface Pipeline { gitless: boolean; }' } }))

    expect(marked.language).toBe('factory')
  })
})
