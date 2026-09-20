import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/
const NOT_OURS = new Set(['node_modules', '.git', 'dist', 'cache'])

export interface Blindness {
  gitIgnores: Set<string>
  eslintIgnores: Set<string>
}

export function unreadSources(sources: string[], blindness: Blindness): string[] {
  return sources.filter(source => blindness.gitIgnores.has(source) && blindness.eslintIgnores.has(source)).sort()
}

function sourceFiles(directory = ROOT, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (NOT_OURS.has(entry.name))
      return []
    if (entry.isDirectory())
      return sourceFiles(path.join(directory, entry.name), relative)
    return entry.isFile() && SOURCE.test(entry.name) ? [relative] : []
  })
}

function ignoredByGit(sources: string[]): Set<string> {
  const read = (): string => {
    try {
      return execFileSync('git', ['check-ignore', '--stdin'], { cwd: ROOT, input: sources.join('\n'), encoding: 'utf8' })
    }
    catch (error) {
      return (error as { stdout?: string }).stdout ?? ''
    }
  }
  return new Set(read().split('\n').filter(Boolean))
}

async function ignoredByEslint(sources: string[]): Promise<Set<string>> {
  const eslint = new ESLint({ cwd: ROOT })
  const verdicts = await Promise.all(sources.map(async source => eslint.isPathIgnored(path.join(ROOT, source))))
  return new Set(sources.filter((_, index) => verdicts[index]))
}

describe('no source file is invisible to every reader at once', () => {
  it('has every source on disk read by git or by eslint, and names any that neither would see', async () => {
    const sources = sourceFiles()
    expect(sources.length).toBeGreaterThan(50)
    const unread = unreadSources(sources, { gitIgnores: ignoredByGit(sources), eslintIgnores: await ignoredByEslint(sources) })
    expect(unread, 'a source both readers ignore is checked by nothing and can change in silence').toEqual([])
  })

  it('names a source that is really invisible, written into a directory both readers skip', async () => {
    const directory = path.join(ROOT, 'bench')
    const probe = path.join(directory, 'reader-probe.ts')
    mkdirSync(directory, { recursive: true })
    writeFileSync(probe, 'export const probe = 1\n')
    try {
      const sources = sourceFiles()
      expect(sources).toContain('bench/reader-probe.ts')
      const unread = unreadSources(sources, { gitIgnores: ignoredByGit(sources), eslintIgnores: await ignoredByEslint(sources) })
      expect(unread).toContain('bench/reader-probe.ts')
    }
    finally {
      rmSync(probe, { force: true })
    }
  })

  it('reports a source both readers ignore, which is how scripts/bench once vanished from each', () => {
    const blindness = { gitIgnores: new Set(['scripts/bench/classify.ts']), eslintIgnores: new Set(['scripts/bench/classify.ts']) }
    expect(unreadSources(['src/cli.ts', 'scripts/bench/classify.ts'], blindness)).toEqual(['scripts/bench/classify.ts'])
  })

  it('accepts a source one reader ignores, because every such exemption leaves the other reader on it', () => {
    const lintExempt = { gitIgnores: new Set<string>(), eslintIgnores: new Set(['templates/harness/eslint.config.mjs']) }
    const gitExempt = { gitIgnores: new Set(['bench/capture.mjs']), eslintIgnores: new Set<string>() }
    expect(unreadSources(['templates/harness/eslint.config.mjs'], lintExempt)).toEqual([])
    expect(unreadSources(['bench/capture.mjs'], gitExempt)).toEqual([])
  })
})
