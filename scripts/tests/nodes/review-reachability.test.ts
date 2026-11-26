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

  it('judges no template payload, dot-directory script or root tool config as product code', () => {
    const added = ['templates/attach/_construct/new-guard.mjs', '.claude/hooks/new-hook.mjs', 'eslint.config.mjs']
    const tree = { ...productTree(false), ...Object.fromEntries(added.map(file => [file, ''])) }

    expect(unreachedModules(headOf(tree, added))).toEqual([])
  })

  it('reads a package entry declared only through exports', () => {
    const exportsOnly = (imports: boolean): Record<string, string> => ({
      'package.json': JSON.stringify({ exports: { '.': { import: './src/index.ts' } } }),
      'src/index.ts': imports ? 'export * from \'./feature/shiny.js\'\n' : 'export {}\n',
      [NEW_MODULE]: 'export {}\n',
    })

    expect(unreachedModules(headOf(exportsOnly(true), [NEW_MODULE]))).toEqual([])
    expect(unreachedModules(headOf(exportsOnly(false), [NEW_MODULE]))).toEqual([{ packageDir: '', modules: [NEW_MODULE], entries: [{ kind: 'main', path: 'src/index.ts' }] }])
  })

  it('counts a packages/ directory without a manifest as part of the root package', () => {
    const tree = {
      'package.json': MANIFEST,
      'src/cli.ts': 'import \'../packages/loose/src/a.js\'\n',
      'packages/loose/src/a.ts': 'export {}\n',
    }

    expect(unreachedModules(headOf(tree, ['packages/loose/src/a.ts']))).toEqual([])
    expect(unreachedModules(headOf({ ...tree, 'src/cli.ts': '' }, ['packages/loose/src/a.ts']))).toEqual([{ packageDir: '', modules: ['packages/loose/src/a.ts'], entries: [{ kind: 'bin', path: 'dist/cli.js' }] }])
  })

  it('names only the root package\'s own entry points, not the pages of a workspace package, each once', () => {
    const tree = {
      'package.json': JSON.stringify({ main: 'dist/cli.js', bin: 'dist/cli.js', exports: './dist/cli.js' }),
      'src/cli.ts': '',
      'packages/web/package.json': JSON.stringify({ name: 'web' }),
      'packages/web/pages/about.tsx': 'import \'../../../src/feature/shiny.js\'\n',
      [NEW_MODULE]: '',
    }

    expect(unreachedModules(headOf(tree, [NEW_MODULE]))).toEqual([{ packageDir: '', modules: [NEW_MODULE], entries: [{ kind: 'bin', path: 'dist/cli.js' }, { kind: 'main', path: 'dist/cli.js' }] }])
  })

  it('leaves an added file that a convention names an entry point to that convention, even where no package scans it', () => {
    const page = 'packages/loose/pages/about.tsx'
    const tree = { ...productTree(false), [page]: 'export default 1\n' }

    expect(unreachedModules(headOf(tree, [page]))).toEqual([])
  })

  it('walks a committed built entry as itself when no source of it exists', () => {
    const tree = {
      'package.json': JSON.stringify({ bin: { tool: 'dist/tool.mjs' } }),
      'dist/tool.mjs': `import '../${NEW_MODULE.replace(/\.ts$/, '.js')}'\n`,
      [NEW_MODULE]: 'export {}\n',
    }

    expect(unreachedModules(headOf(tree, [NEW_MODULE]))).toEqual([])
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

  it('names at most five entry points of a package and marks the rest as cut', () => {
    const pages = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => `src/pages/${name}.tsx`)
    const tree = { 'package.json': JSON.stringify({ name: 'web' }), ...Object.fromEntries(pages.map(page => [page, ''])), [NEW_MODULE]: '' }
    const finding = unreachedFinding(unreachedModules(headOf(tree, [NEW_MODULE])))

    expect(finding).toContain(`(entry points: ${pages.slice(0, 5).map(page => `page ${page}`).join(', ')}, …)`)
    expect(finding).not.toContain(pages[5])
  })

  it('closes the named entry points without a mark when the package has five or fewer', () => {
    expect(unreachedFinding(unreachedModules(headOf(productTree(false), [NEW_MODULE])))).toContain('(entry points: bin dist/cli.js)')
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
