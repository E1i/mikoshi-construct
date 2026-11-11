import type { AnswerRequest } from '../../nodes/answer/answerer.js'
import type { TreeCard, TreePrPorts } from '../../nodes/launch/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runsLine, TestCoverage } from '../../../src/card/covering-tests.js'
import { parkingFileText } from '../../../src/card/parking.js'
import { riskOf } from '../../../src/card/risk.js'
import { TOUCHES_FOLLOWED } from '../../core/events.js'
import { AnswerOutsideTouches, claudeAnswerer, followedEvent } from '../../nodes/answer/answerer.js'
import { runTreePr } from '../../nodes/launch/tree-pr-cli.js'
import { touchesFollowed, treePr } from '../../nodes/launch/tree-pr.js'
import { followsTouches, neverFollows, pathsOutside, rootCopyOf } from '../../policy/touch-scope.js'

const CARD_ID = 1207
const TOUCHED_MODULE = 'src/widget.ts'
const COVERING_TEST = 'tests/widget.test.ts'
const UNRELATED_TEST = 'tests/other.test.ts'
const SURFACE = 'contract/surface.json'
const LINT_CONFIG = 'eslint.config.mjs'
const CLAUDE_FILE = '.claude/rules/widget.md'
const TEMPLATE_RULE = 'templates/ai/shared/_claude/rules/widget.md'
const TEMPLATE_LINT = 'templates/harness/eslint.config.mjs'
const INTAKE_CODE = 'src/commands/intake/check.ts'
const INTAKE_RECORD = 'architecture/composition/intake.yaml'
const INTAKE_DOC = 'architecture/intake.md'

function modelText(id: string, doc: string, nodePath: string): string {
  return `id: ${id}\ntitle: ${id}\ndoc: ${doc}\nnodes:\n  - id: entry\n    label: entry\n    path: ${nodePath}\n`
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function writeInto(worktree: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    writeFileSync(path.join(worktree, file), text)
  }
}

function treeWith(atBase: Record<string, string>, addedByTheCard: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'touchesfollow-'))
  roots.push(root)
  const worktree = path.join(root, 'mc-1207')
  writeInto(worktree, { 'construct.json': `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`, ...atBase })
  execFileSync('git', ['init', '-q', worktree])
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', 'commit', '-q', '-m', 'base'])
  execFileSync('git', ['-C', worktree, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
  writeInto(worktree, addedByTheCard)
  return worktree
}

const CARD_CHANGESET = '.changeset/widget.md'
const ANOTHER_CARDS_CHANGESET = '.changeset/another.md'

const REPOSITORY: Record<string, string> = {
  [TOUCHED_MODULE]: 'export const widget = 1\n',
  [COVERING_TEST]: 'import { widget } from \'../src/widget.js\'\n',
  [UNRELATED_TEST]: 'export const other = 2\n',
  [SURFACE]: '{}\n',
  [LINT_CONFIG]: 'export default []\n',
  [CLAUDE_FILE]: 'rule\n',
  [TEMPLATE_RULE]: 'rule\n',
  [TEMPLATE_LINT]: 'export default []\n',
  [ANOTHER_CARDS_CHANGESET]: '---\n---\n\nanother card\n',
  [INTAKE_CODE]: 'export const intake = 1\n',
  [INTAKE_RECORD]: modelText('intake', INTAKE_DOC, INTAKE_CODE),
  [INTAKE_DOC]: 'the intake flow\n',
}

const CARD_LINE = `#${CARD_ID} widget [implement/construct/S/ladder/auto] · depends — · blocks —`

function cardBody(touches: string[], runs: string[] = []): string {
  return parkingFileText({ card: CARD_LINE, branch: 'feat/widget', touches, continue: 'auto', who: 'shift', body: runs.length === 0 ? 'the widget card' : `the widget card\n\n${runsLine(runs)}` })
}

interface Run {
  published: string[]
  followed: string[][]
  request: AnswerRequest
  answer: () => Promise<unknown>
}

interface AnswerCase {
  runs?: string[]
  pushFails?: boolean
}

function answerChanging(changed: string[], touches: string[], answerCase: AnswerCase = {}): Run {
  const worktree = treeWith(REPOSITORY, { [CARD_CHANGESET]: '---\n---\n\nthe widget\n' })
  const published: string[] = []
  const followed: string[][] = []
  const heads = ['a'.repeat(40), 'e'.repeat(40)]
  const request: AnswerRequest = {
    lease: { taskKey: `answer:${CARD_ID}:1300`, queue: 'answer', cardId: CARD_ID, pr: 1300, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:worker-1' },
    source: { kind: 'changes', findings: ['the widget test is red'], events: [], decisions: [] },
    widened: null,
    card: { session: 'card-session', worktree, branch: 'feat/widget' },
    outsideTouches: paths => pathsOutside(touches, answerCase.runs ?? [], paths),
  }
  const answerer = claudeAnswerer(path.join(path.dirname(worktree), 'answers'), {
    cardText: () => cardBody(touches, answerCase.runs),
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: (card) => {
      if (answerCase.pushFails === true)
        throw new Error('the push was rejected')
      published.push(card.branch)
    },
    pending: () => [TOUCHED_MODULE, ...changed],
    followed: (_lease, paths) => followed.push([...paths]),
  })
  return { published, followed, request, answer: async () => answerer(request) }
}

describe('the touches follow the change: tests, generated twins and the changeset', () => {
  it('an answer that touches a test of a touched module and contract/surface.json commits and pushes without a stop', async () => {
    const run = answerChanging([COVERING_TEST, SURFACE, CARD_CHANGESET], [TOUCHED_MODULE])

    await expect(run.answer()).resolves.toMatchObject({ owner: null, after: 'e'.repeat(40) })
    expect(run.published).toEqual(['feat/widget'])
    expect(run.followed).toEqual([[COVERING_TEST, SURFACE, CARD_CHANGESET]])
  })

  it('an answer that edits another card\'s changeset, present on the base, stops with a question', async () => {
    const run = answerChanging([ANOTHER_CARDS_CHANGESET], [TOUCHED_MODULE])

    await expect(run.answer()).rejects.toThrow(`left changes to ${ANOTHER_CARDS_CHANGESET}, outside`)
    expect(run.published).toEqual([])
  })

  it('an answer that touches eslint.config.mjs or a .claude file stops with a question', async () => {
    const run = answerChanging([COVERING_TEST, LINT_CONFIG, CLAUDE_FILE], [TOUCHED_MODULE, TEMPLATE_RULE, TEMPLATE_LINT])

    const refused = run.answer()
    await expect(refused).rejects.toThrow(AnswerOutsideTouches)
    await expect(refused).rejects.toThrow(`left changes to ${LINT_CONFIG}, ${CLAUDE_FILE}, outside`)
    expect(run.published).toEqual([])
    expect(run.followed).toEqual([])
  })

  it('an answer that touches a test covering no touched file pushes and records the widening', async () => {
    const run = answerChanging([UNRELATED_TEST], [TOUCHED_MODULE])

    await expect(run.answer()).resolves.toMatchObject({ owner: null })
    expect(run.published).toEqual(['feat/widget'])
    expect(run.followed).toEqual([[UNRELATED_TEST]])
  })

  it('an answer that touches a file that is neither a test nor generated stops with a question', async () => {
    const run = answerChanging(['README.md'], [TOUCHED_MODULE])

    await expect(run.answer()).rejects.toThrow('left changes to README.md, outside')
    expect(run.published).toEqual([])
  })

  it('an answer whose outside changes all fall within the card\'s runs pushes and records no widening', async () => {
    const run = answerChanging([UNRELATED_TEST], [TOUCHED_MODULE], { runs: [UNRELATED_TEST] })

    await expect(run.answer()).resolves.toMatchObject({ owner: null })
    expect(run.published).toEqual(['feat/widget'])
    expect(run.followed).toEqual([])
  })

  it('an answer whose push fails records no widening', async () => {
    const run = answerChanging([COVERING_TEST, SURFACE], [TOUCHED_MODULE], { pushFails: true })

    await expect(run.answer()).rejects.toThrow('the push was rejected')
    expect(run.followed).toEqual([])
  })

  it('records the widening as a touches.followed event fenced by the lease generation and keyed by the paths it followed', () => {
    const lease = { taskKey: `answer:${CARD_ID}:1300`, queue: 'answer' as const, cardId: CARD_ID, pr: 1300, head: 'a'.repeat(40), leaseGen: 3, actor: 'worker:answer:worker-1' }
    const ts = '2026-11-03T00:00:00.000Z'

    expect(followedEvent(lease, [SURFACE, COVERING_TEST], ts)).toMatchObject({ type: TOUCHES_FOLLOWED, cardId: CARD_ID, pr: 1300, dedupeKey: `${TOUCHES_FOLLOWED}:${lease.taskKey}:3:${SURFACE},${COVERING_TEST}`, payload: { paths: [SURFACE, COVERING_TEST] } })
    expect(followedEvent(lease, [SURFACE], ts).dedupeKey).not.toBe(followedEvent(lease, [SURFACE, COVERING_TEST], ts).dedupeKey)
  })
})

const OPENED_PR = 1301

function shiftTree(changed: Record<string, string>): string {
  const worktree = treeWith(REPOSITORY, {})
  const origin = path.join(path.dirname(worktree), 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  execFileSync('git', ['-C', worktree, 'remote', 'add', 'origin', origin])
  execFileSync('git', ['-C', worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/main'])
  execFileSync('git', ['-C', worktree, 'fetch', '-q', 'origin'])
  execFileSync('git', ['-C', worktree, 'checkout', '-q', '-b', 'feat/widget'])
  writeInto(worktree, { [TOUCHED_MODULE]: 'export const widget = 2\n', ...changed })
  return worktree
}

function shiftGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=shift', '-c', 'user.email=shift@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function shiftPorts(bodies: string[]): TreePrPorts {
  return {
    git: shiftGit,
    gh: (args) => {
      if (args[1] === 'list')
        return '[]'
      bodies.push(args[args.indexOf('--body') + 1]!)
      return `https://github.com/o/r/pull/${OPENED_PR}\n`
    },
  }
}

const SHIFT_CARD: TreeCard = { branch: 'feat/widget', title: 'widget (#1207)', commitMessage: 'widget (#1207)', cardLine: CARD_LINE, contour: 'ladder', touches: [TOUCHED_MODULE], runs: [], namedPathReason: null }

describe('a card session follows the touches the same way and the shift records it', () => {
  it('the shift opens the pull request with a covering test and a twin outside the touches and names them as followed', () => {
    const bodies: string[] = []
    const worktree = shiftTree({ [COVERING_TEST]: 'import { widget } from \'../src/widget.js\'\n\nexport const twice = widget * 2\n', [SURFACE]: '{"x":1}\n' })

    expect(treePr(shiftPorts(bodies), SHIFT_CARD, worktree, null)).toEqual({ kind: 'pr', number: String(OPENED_PR), followed: [SURFACE, COVERING_TEST] })
    expect(bodies[0]).toContain(`Touches followed: ${SURFACE}, ${COVERING_TEST}`)
  })

  it('the shift opens the pull request with an unrelated test and a generated file of an untouched source, and names them', () => {
    const bodies: string[] = []
    const worktree = shiftTree({ [UNRELATED_TEST]: 'export const other = 3\n', 'architecture/model.md': 'the model\n' })

    expect(treePr(shiftPorts(bodies), SHIFT_CARD, worktree, null)).toEqual({ kind: 'pr', number: String(OPENED_PR), followed: expect.arrayContaining([UNRELATED_TEST, 'architecture/model.md']) })
    expect(bodies[0]).toContain('Touches followed: ')
    expect(bodies[0]).toContain(UNRELATED_TEST)
    expect(bodies[0]).toContain('architecture/model.md')
  })

  it('the shift opens no pull request for a guarded path outside the touches', () => {
    const bodies: string[] = []
    const worktree = shiftTree({ [LINT_CONFIG]: 'export default [1]\n' })

    expect(treePr(shiftPorts(bodies), { ...SHIFT_CARD, touches: [TOUCHED_MODULE, TEMPLATE_LINT] }, worktree, null)).toMatchObject({ kind: 'problem', gaps: [{ reason: 'outside-touches', paths: [LINT_CONFIG] }] })
    expect(bodies).toEqual([])
  })

  it.each([
    ['records a touches.followed event for the paths it followed', { [COVERING_TEST]: 'import { widget } from \'../src/widget.js\'\n\nexport const twice = widget * 2\n' }, [[CARD_ID, OPENED_PR, [COVERING_TEST]]]],
    ['records no touches.followed event when nothing followed', {}, []],
  ])('the shift %s', (_name, changed, recorded) => {
    const worktree = shiftTree(changed)
    const followed: unknown[] = []
    const code = runTreePr([String(CARD_ID), worktree], {
      ...shiftPorts([]),
      card: () => cardBody([TOUCHED_MODULE]),
      opened: () => {},
      followed: (cardId, pr, paths) => followed.push([cardId, pr, [...paths]]),
      stopped: () => {},
      waited: () => {},
      lastRefusal: () => null,
      returned: () => {},
      resume: () => false,
    }, () => {})

    expect(code).toBe(0)
    expect(followed).toEqual(recorded)
  })
})

describe('a composition record follows the code it describes', () => {
  const CHANGED_RECORD = `${REPOSITORY[INTAKE_RECORD]}description: changed\n`
  const GUARDED_RECORD = 'architecture/composition/guarded.yaml'
  const INTAKE_REACH = { touches: [INTAKE_CODE], added: new Set<string>(), compositionRecords: [{ id: 'intake', doc: INTAKE_DOC, nodes: [{ path: INTAKE_CODE }] }] }

  it('a change to intake code with its composition record passes the fence', () => {
    const bodies: string[] = []
    const worktree = shiftTree({ [INTAKE_CODE]: 'export const intake = 2\n', [INTAKE_RECORD]: CHANGED_RECORD, [INTAKE_DOC]: 'the changed flow\n' })

    expect(treePr(shiftPorts(bodies), { ...SHIFT_CARD, touches: [TOUCHED_MODULE, INTAKE_CODE] }, worktree, null)).toEqual({ kind: 'pr', number: String(OPENED_PR), followed: [INTAKE_RECORD, INTAKE_DOC] })
    expect(bodies[0]).toContain(`Touches followed: ${INTAKE_RECORD}, ${INTAKE_DOC}`)
    expect(riskOf(INTAKE_RECORD).level).toBe('R1')
  })

  it('an answer that changes the record of its touched code pushes and records the widening', async () => {
    const run = answerChanging([INTAKE_RECORD, INTAKE_DOC], [TOUCHED_MODULE, INTAKE_CODE])

    await expect(run.answer()).resolves.toMatchObject({ owner: null })
    expect(run.followed).toEqual([[INTAKE_RECORD, INTAKE_DOC]])
  })

  it('a composition record and its document follow only through a node the touches reach', () => {
    const bodies: string[] = []
    const worktree = shiftTree({ [INTAKE_RECORD]: CHANGED_RECORD, [INTAKE_DOC]: 'the changed flow\n' })

    expect(treePr(shiftPorts(bodies), SHIFT_CARD, worktree, null)).toMatchObject({ kind: 'problem', gaps: [{ reason: 'outside-touches', paths: [INTAKE_RECORD, INTAKE_DOC] }] })
    expect(bodies).toEqual([])
    expect(followsTouches(INTAKE_RECORD, INTAKE_REACH)).toBe(true)
    expect(followsTouches(INTAKE_DOC, INTAKE_REACH)).toBe(true)
    expect(followsTouches(INTAKE_DOC, { ...INTAKE_REACH, touches: [TOUCHED_MODULE] })).toBe(false)
    expect(followsTouches(INTAKE_RECORD, { ...INTAKE_REACH, touches: ['src/commands/**'] })).toBe(true)
    expect(followsTouches('architecture/composition/doctor.yaml', INTAKE_REACH)).toBe(false)
    expect(neverFollows(INTAKE_RECORD, INTAKE_REACH)).toBe(false)
    expect(neverFollows(INTAKE_RECORD, { ...INTAKE_REACH, touches: [TOUCHED_MODULE] })).toBe(true)
  })

  it('a node a session adds to the record on its own branch reaches nothing: the fence reads the base', () => {
    const bodies: string[] = []
    const widened = `${REPOSITORY[INTAKE_RECORD]}  - id: widget\n    label: widget\n    path: ${TOUCHED_MODULE}\n`

    expect(treePr(shiftPorts(bodies), SHIFT_CARD, shiftTree({ [INTAKE_RECORD]: widened }), null)).toMatchObject({ kind: 'problem', gaps: [{ reason: 'outside-touches', paths: [INTAKE_RECORD] }] })
    expect(bodies).toEqual([])
  })

  it.each([CLAUDE_FILE, 'architecture/owner-merges.md', 'architecture/security-invariants.md', '.github/workflows/ci.yml', LINT_CONFIG])('a record whose document is the guarded %s lets the record through and holds the document', (doc) => {
    const reach = { touches: [INTAKE_CODE], added: new Set<string>(), compositionRecords: [{ id: 'guarded', doc, nodes: [{ path: INTAKE_CODE }] }] }

    expect(touchesFollowed([doc, GUARDED_RECORD], reach, new TestCoverage(() => [], () => null))).toEqual({ followed: [GUARDED_RECORD], outside: [doc] })
  })
})

describe('a registry test in an application layout follows the touches only by import', () => {
  const SCHEMA = 'apps/api/src/storage/schema.ts'
  const REGISTRY_TEST = 'apps/api/tests/storage/migrations.test.ts'
  const SCHEMA_CARD: TreeCard = { ...SHIFT_CARD, touches: [TOUCHED_MODULE, SCHEMA] }

  it('follows a registry test in an app tests folder that imports the touched schema', () => {
    const bodies: string[] = []
    const worktree = shiftTree({ [SCHEMA]: 'export const MIGRATIONS = [\'burials\', \'cities\']\n', [REGISTRY_TEST]: 'import { MIGRATIONS } from \'../../src/storage/schema.js\'\n\nexport const tables = [...MIGRATIONS, \'cities\']\n' })

    expect(treePr(shiftPorts(bodies), SCHEMA_CARD, worktree, null)).toEqual({ kind: 'pr', number: String(OPENED_PR), followed: [REGISTRY_TEST] })
    expect(bodies[0]).toContain(`Touches followed: ${REGISTRY_TEST}`)
  })

  it('follows an app test that imports no touched file too, and names it', () => {
    const bodies: string[] = []
    const worktree = shiftTree({ [SCHEMA]: 'export const MIGRATIONS = []\n', [REGISTRY_TEST]: 'export const about = [\'schema.ts\', \'src/widget.ts\', \'apps/api/src/storage/schema.ts\']\n' })

    expect(treePr(shiftPorts(bodies), SCHEMA_CARD, worktree, null)).toEqual({ kind: 'pr', number: String(OPENED_PR), followed: [REGISTRY_TEST] })
    expect(bodies[0]).toContain(`Touches followed: ${REGISTRY_TEST}`)
  })

  it('does not follow an app test helper that is no test file', () => {
    const bodies: string[] = []
    const helper = 'apps/api/tests/storage/helper.ts'
    const worktree = shiftTree({ [SCHEMA]: 'export const MIGRATIONS = []\n', [helper]: 'export const about = 1\n' })

    expect(treePr(shiftPorts(bodies), SCHEMA_CARD, worktree, null)).toMatchObject({ kind: 'problem', gaps: [{ reason: 'outside-touches', paths: [helper] }] })
    expect(bodies).toEqual([])
  })
})

describe('the following table', () => {
  it.each([
    ['templates/base/architecture/decisions/x.md', 'architecture/decisions/x.md'],
    ['templates/ai/shared/_claude/rules/x.md', '.claude/rules/x.md'],
    ['templates/harness/package.json.eta', 'package.json'],
    ['templates/presets/node-backend/baseline/_github/workflows/ci.yml', '.github/workflows/ci.yml'],
    ['templates/base/architecture/**', 'architecture/**'],
    ['src/widget.ts', null],
  ])('the root self-hosting copy of %s is %s', (template, copy) => {
    expect(rootCopyOf(template)).toBe(copy)
  })

  it.each([
    [SURFACE, [TOUCHED_MODULE], true],
    [SURFACE, ['scripts/nodes/x.ts'], true],
    ['architecture/add-population.md', ['templates/base/architecture/x.md'], true],
    ['architecture/add-population.md', [TOUCHED_MODULE], true],
    [UNRELATED_TEST, [TOUCHED_MODULE], true],
    ['tests/helper.ts', [TOUCHED_MODULE], false],
    ['architecture/self-hosting-drift.yaml', ['templates/ai/**'], true],
    ['architecture/decisions/x.md', ['templates/base/architecture/decisions/x.md'], true],
    ['architecture/decisions/y.md', ['templates/base/architecture/decisions/x.md'], false],
    [CARD_CHANGESET, [TOUCHED_MODULE], true],
    [ANOTHER_CARDS_CHANGESET, [TOUCHED_MODULE], false],
    ['README.md', [TOUCHED_MODULE], false],
  ])('%s follows the touches %j: %s', (file, touches, follows) => {
    expect(followsTouches(file, { touches, added: new Set([CARD_CHANGESET]), compositionRecords: [] })).toBe(follows)
  })

  it.each([
    [CLAUDE_FILE, true],
    [LINT_CONFIG, true],
    ['architecture/owner-merges.md', true],
    ['architecture/security-invariants.md', true],
    ['.github/workflows/ci.yml', true],
    ['.changeset/config.json', true],
    [INTAKE_RECORD, true],
    ['src/materialize/factory-manifest.ts', true],
    [SURFACE, false],
    [COVERING_TEST, false],
  ])('%s never follows the touches: %s', (file, never) => {
    expect(neverFollows(file, { touches: [TOUCHED_MODULE], added: new Set(), compositionRecords: [] })).toBe(never)
  })

  it('the shift fence lets a test and a generated file through and holds a guarded twin and any other file', () => {
    const coverage = new TestCoverage(() => Object.keys(REPOSITORY), file => REPOSITORY[file] ?? null)

    expect(touchesFollowed([COVERING_TEST, SURFACE, UNRELATED_TEST, LINT_CONFIG, 'README.md'], { touches: [TOUCHED_MODULE, TEMPLATE_LINT], added: new Set(), compositionRecords: [] }, coverage)).toEqual({ followed: [COVERING_TEST, SURFACE, UNRELATED_TEST], outside: [LINT_CONFIG, 'README.md'] })
  })
})
