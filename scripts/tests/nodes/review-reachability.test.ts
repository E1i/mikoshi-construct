import type { HeadReading } from '../../nodes/review/reachability.js'
import type { Review, Reviewer } from '../../nodes/review/reviewer.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { BUS_CONTRACT } from '../../core/bus-adapter.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { REVIEW_RECORDED } from '../../core/events.js'
import { UNREACHED_FINDING_HEAD, unreachedFinding, unreachedModules } from '../../nodes/review/reachability.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { gitReachSource, withUnreached } from '../../nodes/review/review-executor.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from '../bus/github-fake.js'
import { eventsOf, liveBench } from '../bus/merge-bench.js'

const PR = 2237
const CARD = PR + 100
const HEAD = sha('a')
const NEW_MODULE = 'src/feature/shiny.ts'
const MANIFEST = JSON.stringify({ name: 'demo', bin: { demo: 'dist/cli.js' } })
const REVIEWER_FINDING = 'src/program.ts:3 drops the second row'
const cleanups: (() => void)[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

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

function cardText(): string {
  return parkingFileText({
    card: `#${CARD} reachable [implement/construct/S/cheap/auto] · depends — · blocks —`,
    branch: `feat/card-${CARD}`,
    touches: ['src/program.ts'],
    continue: 'stop',
    who: 'shift',
    body: ['Make it reachable.', '', 'Witnesses:', '- pnpm exec vitest run tests/program.test.ts'].join('\n'),
  })
}

function benchWith(reviewer: Reviewer, head: HeadReading): { bench: MergeBench, worker: ReviewWorker, said: string[] } {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bench = liveBench()
  cleanups.push(() => bench.close())
  const text = cardText()
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(BUS_CONTRACT, bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now()))
  bench.tick()
  bench.gitHub.open({ number: PR, head: HEAD, ref: `feat/card-${CARD}`, body: cardBody(PR) })
  bench.tick()
  const said: string[] = []
  const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer, plan: () => fullReview('a fixed plan'), clock: bench.clock.now, session: 'worker-1', say: line => said.push(line), reach: () => head })
  return { bench, worker, said }
}

function reviewerSaying(review: Omit<Review, 'session'>): Reviewer {
  return async () => ({ ...review, session: 'reviewer-1' })
}

function recordedFindings(bench: MergeBench): unknown[] {
  return eventsOf(bench.db, REVIEW_RECORDED).map(payload => [payload.verdict, payload.findings])
}

describe('the review checks that new code is reachable from an entry point', () => {
  it('the review refuses a pull request whose new module no entry point reaches', async () => {
    const { bench, worker, said } = benchWith(reviewerSaying({ verdict: 'pass', findings: [] }), headOf(productTree(false), [NEW_MODULE]))

    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })

    const [[verdict, findings]] = recordedFindings(bench) as [[string, string[]]]
    expect(verdict).toBe('changes')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain(UNREACHED_FINDING_HEAD)
    expect(findings[0]).toContain(NEW_MODULE)
    expect(findings[0]).toContain('bin dist/cli.js')
    expect(said.some(line => line.includes(UNREACHED_FINDING_HEAD))).toBe(true)
  })

  it('the review passes a pull request whose new module an entry point imports', async () => {
    const { bench, worker } = benchWith(reviewerSaying({ verdict: 'pass', findings: [] }), headOf(productTree(true), [NEW_MODULE]))

    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })

    expect(recordedFindings(bench)).toEqual([['pass', []]])
  })

  it('keeps the reviewer\'s own findings beside the reachability finding', async () => {
    const { bench, worker } = benchWith(reviewerSaying({ verdict: 'changes', findings: [REVIEWER_FINDING] }), headOf(productTree(false), [NEW_MODULE]))

    await worker.step()

    const [[, findings]] = recordedFindings(bench) as [[string, string[]]]
    expect(findings.slice(1)).toEqual([REVIEWER_FINDING])
    expect(findings[0]).toContain(UNREACHED_FINDING_HEAD)
  })

  it('a reading of the head that fails records no reachability finding and keeps the reviewer\'s verdict', async () => {
    const failing: HeadReading = {
      added: [NEW_MODULE],
      files: () => {
        throw new Error('no such ref')
      },
      read: () => null,
    }
    const { bench, worker } = benchWith(reviewerSaying({ verdict: 'pass', findings: [] }), failing)

    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })
    expect(recordedFindings(bench)).toEqual([['pass', []]])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not be read'))
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
    const review: Review = { verdict: 'pass', findings: [], session: 's' }

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
