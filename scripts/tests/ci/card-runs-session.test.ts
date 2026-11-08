import type { BusCatalog, CheckCatalog } from '../../ci/card-runs.js'
import type { TreePr, TreePrPorts } from '../../nodes/launch/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runsLine } from '../../../src/card/covering-tests.js'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { busCheckCatalog } from '../../ci/card-runs.js'
import { catalogLayersByTest, catalogModuleLayers, writeCatalog } from '../../cli/check-catalog.js'
import { openDatabase } from '../../core/sqlite.js'
import { answerFollowed, shiftTreeCard, treePr, worktreeCoverage } from '../../nodes/launch/tree-pr.js'
import { gitDepthSources } from '../../nodes/review/depth-sources.js'
import { planReview } from '../../nodes/review/review-depth.js'

const TREE_TIMEOUT_MS = 120_000
const CARD_ID = 1128
const CARD_LINE = `#${CARD_ID} a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —`
const BRANCH = 'feat/a-card'
const TOUCHED = 'scripts/nodes/review/review-worker.ts'
const MASKED_TEST = 'scripts/tests/bus/merge-worker.test.ts'
const OTHER_TEST = 'scripts/tests/ghosts/other.test.ts'
const HELPER = 'scripts/tests/bus/helper.ts'
const MASK_ON_BUS = `Do it.\n\n${runsLine(['layer:bus'])}`
const FULL_READING = 'Runs read in full: '
const EMPTY: CheckCatalog = { testLayers: new Map(), moduleLayers: new Map() }
const CATALOG: CheckCatalog = {
  testLayers: new Map([
    [MASKED_TEST, ['bus']],
    [OTHER_TEST, ['ghosts']],
  ]),
  moduleLayers: new Map([
    [TOUCHED, ['bus']],
    ['scripts/ghosts/other.ts', ['ghosts']],
  ]),
}
const NO_TEST_OF_THE_MASK: CheckCatalog = { testLayers: new Map([[OTHER_TEST, ['ghosts']]]), moduleLayers: CATALOG.moduleLayers }
const BASE: Record<string, string> = {
  [TOUCHED]: 'export const worker = 1\n',
  [MASKED_TEST]: 'export const ran = 1\n',
  [OTHER_TEST]: 'export const other = 1\n',
  [HELPER]: 'export const helper = 1\n',
}
const EDIT_OF_MASKED_TEST = { [TOUCHED]: 'export const worker = 2\n', [MASKED_TEST]: 'export const ran = 2\n' }
const EDIT_OF_OTHER_TEST = { [TOUCHED]: 'export const worker = 2\n', [OTHER_TEST]: 'export const other = 2\n' }
const EDIT_OF_HELPER = { [TOUCHED]: 'export const worker = 2\n', [HELPER]: 'export const helper = 2\n' }
const EDIT_OF_THE_TOUCH = { [TOUCHED]: 'export const worker = 2\n' }

const roots: string[] = []
let template = ''

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
}

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'card-runs-session-'))
  roots.push(root)
  return root
}

beforeAll(() => {
  template = mkdtempSync(path.join(tmpdir(), 'card-runs-session-template-'))
  const worktree = path.join(template, 'tree')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(template, 'origin.git')])
  execFileSync('git', ['init', '-q', '-b', 'main', worktree])
  git(worktree, ['config', 'user.email', 'shift@example.com'])
  git(worktree, ['config', 'user.name', 'shift'])
  git(worktree, ['config', 'commit.gpgsign', 'false'])
  write(worktree, BASE)
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-q', '-m', 'base'])
  git(worktree, ['remote', 'add', 'origin', '../origin.git'])
  git(worktree, ['push', '-q', 'origin', 'main'])
  git(worktree, ['fetch', '-q', 'origin'])
  git(worktree, ['checkout', '-q', '-b', BRANCH])
}, TREE_TIMEOUT_MS)

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(template, { recursive: true, force: true })
})

function cardTree(): string {
  const root = freshRoot()
  cpSync(template, root, { recursive: true })
  return path.join(root, 'tree')
}

function cardText(body: string, touches: string[] = [TOUCHED]): string {
  return parkingFileText({ card: CARD_LINE, branch: BRANCH, touches, continue: 'stop', who: 'shift', body })
}

function taskOf(text: string) {
  const parsed = parseParkingFile(`${CARD_ID}.md`, text)
  if (parsed.kind !== 'parked')
    throw new Error(parsed.reason)
  return parsed.parked.task
}

function pullRequest(body: string, catalog: BusCatalog, edit: Record<string, string>): { pr: TreePr, prBody: string } {
  const worktree = cardTree()
  write(worktree, edit)
  let prBody = ''
  const ports: TreePrPorts = {
    git,
    gh: (args) => {
      if (args[1] === 'list')
        return '[]'
      prBody = args[args.indexOf('--body') + 1]!
      return 'https://github.com/owner/repo/pull/954\n'
    },
  }
  return { pr: treePr(ports, shiftTreeCard(taskOf(cardText(body)), catalog), worktree, null), prBody }
}

function reviewFindings(body: string, catalog: BusCatalog, files: string[]): string[] {
  const plan = reviewPlan(body, catalog, files)
  return plan.depth === 'diff' && plan.round === 'first' ? plan.touchFindings : []
}

function reviewNotes(body: string, catalog: BusCatalog, files: string[]): string[] {
  const plan = reviewPlan(body, catalog, files)
  return plan.depth === 'diff' && plan.round === 'first' ? plan.touchNotes : []
}

function reviewPlan(body: string, catalog: BusCatalog, files: string[]) {
  const text = cardText(body)
  const sources = {
    ...gitDepthSources('/nowhere', '/nowhere/morse.jsonl', () => text, () => '', () => catalog),
    base: () => 'base',
    predict: (task: string, base: string, head: string) => ({ prediction: { task, base, head, verdict: 'cheap' as const, rule: 'docs-only' as const, why: files }, files, added: [] }),
  }
  return planReview({ taskKey: `review:${CARD_ID}:954:x`, queue: 'review', cardId: CARD_ID, pr: 954, head: 'head', leaseGen: 1, actor: 'worker:review:x' }, null, sources)
}

describe('the card session and the review read the runs of a card from one source', () => {
  it('a test of a masked layer counts as a run of the card in the pull request and in the review', () => {
    expect(pullRequest(MASK_ON_BUS, CATALOG, EDIT_OF_MASKED_TEST).pr).toEqual({ kind: 'pr', number: '954', followed: [] })
    expect(reviewFindings(MASK_ON_BUS, CATALOG, Object.keys(EDIT_OF_MASKED_TEST))).toEqual([])
    expect(reviewNotes(MASK_ON_BUS, CATALOG, Object.keys(EDIT_OF_MASKED_TEST))).toEqual([])

    expect(pullRequest(MASK_ON_BUS, CATALOG, EDIT_OF_OTHER_TEST).pr).toEqual({ kind: 'pr', number: '954', followed: [OTHER_TEST] })
    expect(reviewFindings(MASK_ON_BUS, CATALOG, Object.keys(EDIT_OF_OTHER_TEST))).toEqual([])
    expect(reviewNotes(MASK_ON_BUS, CATALOG, Object.keys(EDIT_OF_OTHER_TEST))).toEqual([expect.stringContaining(OTHER_TEST)])
  }, TREE_TIMEOUT_MS)

  it('a card with no runs takes the tests of the layers its touches reach, in both readers', () => {
    expect(shiftTreeCard(taskOf(cardText('Do it.')), CATALOG).runs).toEqual([MASKED_TEST])
    expect(reviewFindings('Do it.', CATALOG, Object.keys(EDIT_OF_MASKED_TEST))).toEqual([])
  })

  it('an answer session counts a test of a masked layer as a run, and names only the other test as followed', () => {
    const worktree = cardTree()
    const followed = answerFollowed(git, worktree, [MASKED_TEST, OTHER_TEST], CARD_ID, cardText(MASK_ON_BUS), worktreeCoverage(git, worktree), CATALOG)
    expect(followed).toEqual({ followed: [OTHER_TEST], outside: [] })
  }, TREE_TIMEOUT_MS)

  it('a card body that does not parse carries no mask into an answer session', () => {
    const worktree = cardTree()
    const followed = answerFollowed(git, worktree, [MASKED_TEST], CARD_ID, MASK_ON_BUS, worktreeCoverage(git, worktree), CATALOG)
    expect(followed).toEqual({ followed: [MASKED_TEST], outside: [] })
  }, TREE_TIMEOUT_MS)

  it('a full reading widens no permission', () => {
    const refused = pullRequest(MASK_ON_BUS, EMPTY, EDIT_OF_HELPER).pr
    expect(refused.kind === 'problem' && refused.why).toContain(`the card's touches for ${HELPER}`)
    expect(refused.kind === 'problem' && refused.why).toContain(`${FULL_READING}the check catalog is empty`)

    for (const catalog of [EMPTY, NO_TEST_OF_THE_MASK]) {
      expect(shiftTreeCard(taskOf(cardText(MASK_ON_BUS)), catalog).runs).toEqual([])
      expect(reviewFindings(MASK_ON_BUS, catalog, [HELPER])).toEqual([expect.stringContaining(FULL_READING)])
    }
    const unknownTouch = shiftTreeCard(taskOf(cardText('Do it.', ['CONTRIBUTING.md'])), CATALOG)
    expect(unknownTouch.runs).toEqual([])
    expect(unknownTouch.fullReading).toContain('CONTRIBUTING.md belongs to no layer of the check catalog')

    const inside = pullRequest(MASK_ON_BUS, EMPTY, EDIT_OF_THE_TOUCH)
    expect(inside.pr).toEqual({ kind: 'pr', number: '954', followed: [] })
    expect(inside.prBody).not.toContain(FULL_READING)
  }, TREE_TIMEOUT_MS)

  it('a full reading keeps the paths the card names and adds nothing to them', () => {
    const named = shiftTreeCard(taskOf(cardText(`Do it.\n\n${runsLine([MASKED_TEST, 'layer:bus'])}`)), EMPTY)
    expect(named.runs).toEqual([MASKED_TEST])
    expect(named.fullReading).toBe('the check catalog is empty')
  })

  it('a card with explicit paths and no mask behaves as before', () => {
    const body = `Do it.\n\n${runsLine([MASKED_TEST])}`
    const allowed = pullRequest(body, CATALOG, EDIT_OF_MASKED_TEST)
    expect(allowed.pr).toEqual({ kind: 'pr', number: '954', followed: [] })
    expect(allowed.prBody).not.toContain(FULL_READING)
    expect(reviewFindings(body, CATALOG, Object.keys(EDIT_OF_MASKED_TEST))).toEqual([])

    expect(pullRequest(body, CATALOG, EDIT_OF_HELPER).pr).toMatchObject({ kind: 'problem' })
    expect(reviewFindings(body, CATALOG, Object.keys(EDIT_OF_HELPER))).toEqual([`${HELPER} is outside the touches of card #${CARD_ID} (${TOUCHED})`])
    expect(shiftTreeCard(taskOf(cardText(body)), CATALOG).runs).toEqual([MASKED_TEST])
  }, TREE_TIMEOUT_MS)
})

describe('the check catalog of the bus', () => {
  it('reads as empty from a bus that is not there, so the card falls to a full reading', () => {
    expect(busCheckCatalog(path.join(freshRoot(), 'no-bus.db'))).toEqual(EMPTY)
  })

  it('reads as empty from a bus with no catalog tables', () => {
    const bus = path.join(freshRoot(), 'bus.db')
    openDatabase(bus).close()
    expect(busCheckCatalog(bus)).toEqual(EMPTY)
  })

  it('reads the rows the check catalog wrote', () => {
    const bus = path.join(freshRoot(), 'bus.db')
    const db = openDatabase(bus)
    writeCatalog(db, {
      tests: [{ test: MASKED_TEST, layer: 'bus,core', kind: 'unit', what: '', witness: '' }, { test: OTHER_TEST, layer: 'none', kind: 'unit', what: '', witness: '' }],
      mutations: [],
      modules: [{ module: TOUCHED, layers: ['bus'] }],
    })
    const exported = { testLayers: catalogLayersByTest(db), moduleLayers: catalogModuleLayers(db) }
    db.close()
    const catalog = busCheckCatalog(bus)
    expect(catalog).toEqual(exported)
    expect(catalog).toEqual({
      testLayers: new Map([[MASKED_TEST, ['bus', 'core']], [OTHER_TEST, []]]),
      moduleLayers: new Map([[TOUCHED, ['bus']]]),
    })
  })

  it('names an unreadable bus as unreadable, not as an empty catalog, in the refusal and in the review', () => {
    const bus = path.join(freshRoot(), 'bus.db')
    writeFileSync(bus, 'not a database, and long enough to be read as a broken header')
    const unreadable = busCheckCatalog(bus)
    expect(unreadable.unreadable).toContain('the check catalog could not be read: ')

    const refused = pullRequest(MASK_ON_BUS, unreadable, EDIT_OF_HELPER).pr
    expect(refused.kind === 'problem' && refused.why).toContain(`${FULL_READING}${unreadable.unreadable}`)
    expect(refused.kind === 'problem' && refused.why).not.toContain('the check catalog is empty')

    const [finding] = reviewFindings(MASK_ON_BUS, unreadable, [HELPER])
    expect(finding).toContain(`${FULL_READING}${unreadable.unreadable}`)
    expect(finding).not.toContain('the check catalog is empty')
  }, TREE_TIMEOUT_MS)

  it('an unreadable bus keeps the paths the card names and adds nothing to them', () => {
    const unreadable = { ...EMPTY, unreadable: 'the check catalog could not be read: database is locked' }
    const card = shiftTreeCard(taskOf(cardText(`Do it.\n\n${runsLine([MASKED_TEST, 'layer:bus'])}`)), unreadable)
    expect(card.runs).toEqual([MASKED_TEST])
    expect(card.fullReading).toBe(unreadable.unreadable)
  })
})
