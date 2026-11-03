import type { AnswerRequest } from '../../nodes/answer/answerer.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pathsOutside, TestCoverage } from '../../../src/card/covering-tests.js'
import { parkingFileText } from '../../../src/card/parking.js'
import { followsTouches, neverFollows, rootCopyOf } from '../../../src/commands/intake/check.js'
import { TOUCHES_FOLLOWED } from '../../core/events.js'
import { AnswerOutsideTouches, claudeAnswerer, followedEvent } from '../../nodes/answer/answerer.js'
import { touchesFollowed } from '../../nodes/launch/tree-pr.js'

const CARD_ID = 1207
const TOUCHED_MODULE = 'src/widget.ts'
const COVERING_TEST = 'tests/widget.test.ts'
const UNRELATED_TEST = 'tests/other.test.ts'
const SURFACE = 'contract/surface.json'
const LINT_CONFIG = 'eslint.config.mjs'
const CLAUDE_FILE = '.claude/rules/widget.md'
const TEMPLATE_RULE = 'templates/ai/shared/_claude/rules/widget.md'
const TEMPLATE_LINT = 'templates/harness/eslint.config.mjs'

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
}

function cardBody(touches: string[]): string {
  return parkingFileText({ card: `#${CARD_ID} widget [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: 'feat/widget', touches, continue: 'auto', who: 'shift', body: 'the widget card' })
}

interface Run {
  published: string[]
  followed: string[][]
  request: AnswerRequest
  answer: () => Promise<unknown>
}

function answerChanging(changed: string[], touches: string[]): Run {
  const worktree = treeWith(REPOSITORY, { [CARD_CHANGESET]: '---\n---\n\nthe widget\n' })
  const published: string[] = []
  const followed: string[][] = []
  const heads = ['a'.repeat(40), 'e'.repeat(40)]
  const request: AnswerRequest = {
    lease: { taskKey: `answer:${CARD_ID}:1300`, queue: 'answer', cardId: CARD_ID, pr: 1300, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:worker-1' },
    source: { kind: 'changes', findings: ['the widget test is red'], events: [] },
    widened: null,
    card: { session: 'card-session', worktree, branch: 'feat/widget' },
    outsideTouches: paths => pathsOutside(touches, [], paths),
  }
  const answerer = claudeAnswerer(path.join(path.dirname(worktree), 'answers'), {
    cardText: () => cardBody(touches),
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: card => published.push(card.branch),
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

  it('an answer that touches a test covering no touched file stops with a question', async () => {
    const run = answerChanging([UNRELATED_TEST], [TOUCHED_MODULE])

    await expect(run.answer()).rejects.toThrow(`left changes to ${UNRELATED_TEST}, outside`)
    expect(run.published).toEqual([])
  })

  it('records the widening as a touches.followed event fenced by the lease generation', () => {
    const lease = { taskKey: `answer:${CARD_ID}:1300`, queue: 'answer' as const, cardId: CARD_ID, pr: 1300, head: 'a'.repeat(40), leaseGen: 3, actor: 'worker:answer:worker-1' }

    expect(followedEvent(lease, [SURFACE], '2026-11-03T00:00:00.000Z')).toMatchObject({ type: TOUCHES_FOLLOWED, cardId: CARD_ID, pr: 1300, dedupeKey: `${TOUCHES_FOLLOWED}:${lease.taskKey}:3`, payload: { paths: [SURFACE] } })
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
    [SURFACE, ['scripts/nodes/x.ts'], false],
    ['architecture/add-population.md', ['templates/base/architecture/x.md'], true],
    ['architecture/add-population.md', [TOUCHED_MODULE], false],
    ['architecture/self-hosting-drift.yaml', ['templates/ai/**'], true],
    ['architecture/decisions/x.md', ['templates/base/architecture/decisions/x.md'], true],
    ['architecture/decisions/y.md', ['templates/base/architecture/decisions/x.md'], false],
    [CARD_CHANGESET, [TOUCHED_MODULE], true],
    [ANOTHER_CARDS_CHANGESET, [TOUCHED_MODULE], false],
    ['README.md', [TOUCHED_MODULE], false],
  ])('%s follows the touches %j: %s', (file, touches, follows) => {
    expect(followsTouches(file, { touches, added: new Set([CARD_CHANGESET]) })).toBe(follows)
  })

  it.each([
    [CLAUDE_FILE, true],
    [LINT_CONFIG, true],
    ['architecture/owner-merges.md', true],
    ['architecture/security-invariants.md', true],
    ['.github/workflows/ci.yml', true],
    ['.changeset/config.json', true],
    ['src/materialize/factory-manifest.ts', true],
    [SURFACE, false],
    [COVERING_TEST, false],
  ])('%s never follows the touches: %s', (file, never) => {
    expect(neverFollows(file)).toBe(never)
  })

  it('the shift fence lets a covering test and a twin through and holds a guarded twin and an unrelated test', () => {
    const coverage = new TestCoverage(() => Object.keys(REPOSITORY), file => REPOSITORY[file] ?? null)

    expect(touchesFollowed([COVERING_TEST, SURFACE, UNRELATED_TEST, LINT_CONFIG], { touches: [TOUCHED_MODULE, TEMPLATE_LINT], added: new Set() }, coverage)).toEqual({ followed: [COVERING_TEST, SURFACE], outside: [UNRELATED_TEST, LINT_CONFIG] })
  })
})
