import type { HeadReading, Verdicted } from '../../nodes/review/reachability.js'
import { describe, expect, it, vi } from 'vitest'
import { gitReachSource, reviewedOnTheHead, UNREACHED_FINDING_HEAD, unreachedFinding, unreachedModules, withUnreached } from '../../nodes/review/reachability.js'

const HEAD = 'a'.repeat(40)
const NEW_MODULE = 'src/feature/shiny.ts'
const MANIFEST = JSON.stringify({ name: 'demo', bin: { demo: 'dist/cli.js' } })
const REVIEWER_FINDING = 'src/program.ts:3 drops the second row'
const PASS: Verdicted = { verdict: 'pass', findings: [] }

function headOf(tree: Record<string, string>, added: readonly string[]): HeadReading {
  return { added, files: () => Object.keys(tree), read: file => tree[file] ?? null }
}

function productTree(programImportsTheModule: boolean): Record<string, string> {
  return {
    'package.json': MANIFEST,
    'src/cli.ts': 'import { run } from \'./program.js\'\nrun()\n',
    'src/program.ts': programImportsTheModule ? 'import { shiny } from \'./feature/shiny.js\'\nexport const run = shiny\n' : 'export function run() {}\n',
    [NEW_MODULE]: 'export function shiny() {}\n',
  }
}

describe('the review checks that new code is reachable from an entry point', () => {
  it('the review refuses a pull request whose new module no entry point reaches', () => {
    const reviewed = reviewedOnTheHead(PASS, headOf(productTree(false), [NEW_MODULE]))

    expect(reviewed.verdict).toBe('changes')
    expect(reviewed.findings).toHaveLength(1)
    expect(reviewed.findings[0]).toContain(UNREACHED_FINDING_HEAD)
    expect(reviewed.findings[0]).toContain(NEW_MODULE)
    expect(reviewed.findings[0]).toContain('bin dist/cli.js')
  })

  it('the review passes a pull request whose new module an entry point imports', () => {
    expect(reviewedOnTheHead(PASS, headOf(productTree(true), [NEW_MODULE]))).toEqual(PASS)
  })

  it('keeps the reviewer\'s own findings beside the reachability finding', () => {
    const reviewed = reviewedOnTheHead({ verdict: 'changes', findings: [REVIEWER_FINDING] }, headOf(productTree(false), [NEW_MODULE]))

    expect(reviewed.findings[0]).toContain(UNREACHED_FINDING_HEAD)
    expect(reviewed.findings.slice(1)).toEqual([REVIEWER_FINDING])
  })
})

describe('unreachedModules', () => {
  it('ignores added files outside the product: scripts, tests and docs', () => {
    const tree = { ...productTree(false), 'scripts/tool.ts': '', 'tests/x.test.ts': '', 'docs/a.md': '' }

    expect(unreachedModules(headOf(tree, ['scripts/tool.ts', 'tests/x.test.ts', 'docs/a.md']))).toEqual([])
  })

  it('judges nothing in a package that declares no entry point', () => {
    const tree = { 'package.json': JSON.stringify({ name: 'lib' }), [NEW_MODULE]: '' }

    expect(unreachedModules(headOf(tree, [NEW_MODULE]))).toEqual([])
  })

  it('counts an added module that is itself an entry point as reached', () => {
    const tree = { 'package.json': JSON.stringify({ name: 'web' }), 'src/pages/about.tsx': 'export default 1\n', 'src/pages/index.tsx': '' }

    expect(unreachedModules(headOf(tree, ['src/pages/about.tsx']))).toEqual([])
  })

  it('walks from a built bin outside src to its source at the package root', () => {
    const tree = {
      'package.json': JSON.stringify({ bin: { tool: 'dist/bin/tool.js' } }),
      'bin/tool.ts': 'import \'../src/lib/core.js\'\n',
      'src/lib/core.ts': 'export {}\n',
    }

    expect(unreachedModules(headOf(tree, ['src/lib/core.ts']))).toEqual([])
  })

  it('judges a workspace package by its own entry points only', () => {
    const tree = {
      'package.json': MANIFEST,
      'src/cli.ts': 'import \'../packages/web/src/orphan.js\'\n',
      'packages/web/package.json': JSON.stringify({ main: 'src/index.ts' }),
      'packages/web/src/index.ts': 'export {}\n',
      'packages/web/src/orphan.ts': 'export {}\n',
    }

    expect(unreachedModules(headOf(tree, ['packages/web/src/orphan.ts']))).toEqual([{ packageDir: 'packages/web', modules: ['packages/web/src/orphan.ts'], entries: [{ kind: 'main', path: 'packages/web/src/index.ts' }] }])
  })

  it('reads no file of the head when nothing added is product code', () => {
    const files = vi.fn(() => [])

    expect(unreachedModules({ added: ['scripts/a.ts'], files, read: () => null })).toEqual([])
    expect(files).not.toHaveBeenCalled()
  })
})

describe('the finding and its place in the verdict', () => {
  it('names no finding when every new module is reached', () => {
    expect(unreachedFinding([])).toBeNull()
  })

  it('turns a pass into changes and leaves a review with no finding unchanged', () => {
    const review: Verdicted = { verdict: 'pass', findings: [] }

    expect(withUnreached(review, null)).toBe(review)
    expect(withUnreached(review, 'f')).toEqual({ ...review, verdict: 'changes', findings: ['f'] })
    expect(withUnreached({ ...review, verdict: 'changes', findings: ['f', 'g'] }, 'f').findings).toEqual(['f', 'g'])
  })

  it('reads the head through git: merge-base, the added files, the tree and each file at the head', () => {
    const calls: string[][] = []
    const outputs: Record<string, string> = { 'merge-base': 'base\n', 'diff': `${NEW_MODULE}\0`, 'ls-tree': `package.json\0${NEW_MODULE}\0`, 'show': 'text' }
    const reading = gitReachSource('/repo', (_, args) => {
      calls.push(args)
      return outputs[args[0]!]!
    })(HEAD)

    expect(reading.added).toEqual([NEW_MODULE])
    expect(reading.files()).toEqual(['package.json', NEW_MODULE])
    expect(reading.read(NEW_MODULE)).toBe('text')
    expect(calls).toEqual([
      ['merge-base', 'origin/main', HEAD],
      ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', 'base', HEAD],
      ['ls-tree', '-r', '--name-only', '-z', HEAD],
      ['show', `${HEAD}:${NEW_MODULE}`],
    ])
  })
})
