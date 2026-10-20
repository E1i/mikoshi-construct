import type { IntakeResult } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseParkingFile } from '../src/card/parking.js'
import { runIntake } from '../src/commands/intake/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { repo: string, parking: string, journal: string, draft: string }

function world(files: Record<string, string>, touches: string[]): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-covering-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), text)
  }
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards: [{ name: 'covered-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', touches, task: 'Change the code.', witnesses: ['`pnpm run quality` is green'] }] }))
  return { repo, parking: path.join(root, 'parking'), journal: path.join(root, 'ghosts.jsonl'), draft }
}

function intake(w: World): IntakeResult {
  return runIntake({ draft: w.draft, taken: '-', parking: w.parking, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, readStdin: () => '12' })
}

function parkedTouches(w: World): string[] {
  const parsed = parseParkingFile('13.md', readFileSync(path.join(w.parking, '13.md'), 'utf8'))
  return parsed.kind === 'parked' ? parsed.parked.task.touches : []
}

function journalLines(w: World): Record<string, unknown>[] {
  return existsSync(w.journal) ? readFileSync(w.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

describe('intake puts the tests that cover the touched files into touches', () => {
  it('a card that changes a script in package.json carries tests/contributing-scripts.test.ts and tests/harness-membership.test.ts in touches', () => {
    const w = world({
      'package.json': '{ "scripts": {} }\n',
      'CONTRIBUTING.md': '# Contributing\n',
      'tests/contributing-scripts.test.ts': 'import { packageScripts } from \'./package-scripts.js\'\n',
      'tests/package-scripts.ts': 'export const packageScripts = {}\n',
      'tests/harness-membership.test.ts': 'export {}\n',
    }, ['package.json'])
    expect(intake(w).status).toBe('written')
    expect(parkedTouches(w)).toEqual(expect.arrayContaining(['package.json', 'tests/contributing-scripts.test.ts', 'tests/harness-membership.test.ts']))
  })

  it('a card that changes the fields of the card.answered event carries scripts/tests/bus/answer-queue.test.ts in touches', () => {
    const w = world({
      'scripts/bus/inbox.ts': 'export const CARD_ANSWERED = \'card.answered\'\n',
      'scripts/bus/answer-executor.ts': 'import { CARD_ANSWERED } from \'./inbox.js\'\n\nexport const answered = { type: CARD_ANSWERED }\n',
      'scripts/tests/bus/answer-queue.test.ts': 'import { AnswerExecutor } from \'../../bus/answer-executor.js\'\nimport { CARD_ANSWERED } from \'../../bus/inbox.js\'\n',
    }, ['scripts/bus/answer-executor.ts'])
    expect(intake(w).status).toBe('written')
    expect(parkedTouches(w)).toEqual(['scripts/bus/answer-executor.ts', 'scripts/tests/bus/answer-queue.test.ts'])
  })

  it('a card that changes src/card/risk.ts carries tests/intake-confirm-gate.test.ts and tests/intake-split-signal.test.ts in touches', () => {
    const w = world({
      'src/card/risk.ts': 'export const RISK_PREFIX = \'risk: \'\n',
      'src/commands/intake/confirm.ts': 'import { SEAM_PREFIX } from \'../../card/risk.js\'\n',
      'src/commands/intake/index.ts': 'import { awaitsConfirmation } from \'./confirm.js\'\n',
      'tests/intake-confirm-gate.test.ts': 'import { runIntake } from \'../src/commands/intake/index.js\'\n',
      'tests/intake-split-signal.test.ts': 'import { SEAM_PREFIX } from \'../src/card/risk.js\'\n',
      'tests/ui.test.ts': 'import { createUi } from \'../src/ui/console.js\'\n',
      'src/ui/console.ts': 'export function createUi() {}\n',
    }, ['src/card/risk.ts'])
    expect(intake(w).status).toBe('written')
    expect(parkedTouches(w)).toEqual(['src/card/risk.ts', 'tests/intake-confirm-gate.test.ts', 'tests/intake-split-signal.test.ts'])
  })

  it('a card that changes scripts/bus/review-worker.ts carries scripts/tests/bus/review-worker.test.ts in touches without a person', () => {
    const w = world({
      'scripts/bus/review-worker.ts': 'export function runReviewWorker() {}\n',
      'scripts/tests/bus/review-worker.test.ts': 'import {\n  runReviewWorker,\n} from \'../../bus/review-worker.js\'\n',
      'scripts/tests/bus/merge-worker.test.ts': 'import { runMergeWorker } from \'../../bus/merge-worker.js\'\n',
      'scripts/bus/merge-worker.ts': 'export function runMergeWorker() {}\n',
    }, ['scripts/bus/review-worker.ts'])
    expect(intake(w).status).toBe('written')
    expect(parkedTouches(w)).toEqual(['scripts/bus/review-worker.ts', 'scripts/tests/bus/review-worker.test.ts'])
    expect(journalLines(w)).toMatchObject([{ task: '13', confirmation: 'none' }])
  })

  it('covering tests do not count toward the touches signal of the complexity seam', () => {
    const tests = Object.fromEntries(Array.from({ length: 8 }, (_, at) => [`scripts/tests/shift/part-${at}/covering.test.ts`, 'import { runShift } from \'../../../shift/shift.js\'\n']))
    const w = world({ 'scripts/shift/shift.ts': 'export function runShift() {}\n', ...tests }, ['scripts/shift/shift.ts'])
    expect(intake(w).status).toBe('written')
    expect(parkedTouches(w)).toHaveLength(9)
    expect(readFileSync(path.join(w.parking, '13.md'), 'utf8')).not.toContain('seam: ')
  })

  it('a directory holding more than six covering tests is carried as one mask', () => {
    const tests = Object.fromEntries(Array.from({ length: 7 }, (_, at) => [`scripts/tests/bus/covering-${at}.test.ts`, 'import { runReviewWorker } from \'../../bus/review-worker.js\'\n']))
    const w = world({ 'scripts/bus/review-worker.ts': 'export function runReviewWorker() {}\n', 'scripts/tests/ci/one.test.ts': 'import \'../../bus/review-worker.js\'\n', ...tests }, ['scripts/bus/review-worker.ts'])
    expect(intake(w).status).toBe('written')
    expect(parkedTouches(w)).toEqual(['scripts/bus/review-worker.ts', 'scripts/tests/bus/**', 'scripts/tests/ci/one.test.ts'])
  })
})
