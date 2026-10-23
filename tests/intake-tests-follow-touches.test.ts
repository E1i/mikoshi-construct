import type { CardEvent, CardEventPort, IntakeResult } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runsOf } from '../src/card/covering-tests.js'
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

function intake(w: World, events?: CardEventPort): IntakeResult {
  return runIntake({ draft: w.draft, taken: '-', parking: w.parking, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, readStdin: () => '12', events })
}

function parked(w: World, bus?: readonly CardEvent[]): { touches: string[], runs: string[] } {
  const text = bus === undefined ? readFileSync(path.join(w.parking, '13.md'), 'utf8') : String(bus.at(-1)?.payload.text)
  const parsed = parseParkingFile('13.md', text)
  return parsed.kind === 'parked' ? { touches: parsed.parked.task.touches, runs: runsOf(parsed.parked.task.body) } : { touches: [], runs: [] }
}

describe('intake puts the tests that cover the touched files into runs, not touches', () => {
  it('a card that changes a script in package.json runs tests/contributing-scripts.test.ts and tests/harness-membership.test.ts', () => {
    const w = world({
      'package.json': '{ "scripts": {} }\n',
      'CONTRIBUTING.md': '# Contributing\n',
      'tests/contributing-scripts.test.ts': 'import { packageScripts } from \'./package-scripts.js\'\n',
      'tests/package-scripts.ts': 'export const packageScripts = {}\n',
      'tests/harness-membership.test.ts': 'export {}\n',
    }, ['package.json'])
    expect(intake(w).status).toBe('written')
    expect(parked(w)).toEqual({ touches: ['package.json', 'CONTRIBUTING.md', 'tests/harness-membership.test.ts'], runs: ['tests/contributing-scripts.test.ts'] })
  })

  it('a card that changes the fields of the card.answered event runs scripts/tests/bus/answer-queue.test.ts', () => {
    const w = world({
      'scripts/bus/inbox.ts': 'export const CARD_ANSWERED = \'card.answered\'\n',
      'scripts/bus/answer-executor.ts': 'import { CARD_ANSWERED } from \'./inbox.js\'\n\nexport const answered = { type: CARD_ANSWERED }\n',
      'scripts/tests/bus/answer-queue.test.ts': 'import { AnswerExecutor } from \'../../bus/answer-executor.js\'\nimport { CARD_ANSWERED } from \'../../bus/inbox.js\'\n',
    }, ['scripts/bus/answer-executor.ts'])
    expect(intake(w).status).toBe('written')
    expect(parked(w)).toEqual({ touches: ['scripts/bus/answer-executor.ts'], runs: ['scripts/tests/bus/answer-queue.test.ts'] })
  })

  it('a card that changes src/card/risk.ts runs tests/intake-confirm-gate.test.ts and tests/intake-split-signal.test.ts', () => {
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
    expect(parked(w)).toEqual({ touches: ['src/card/risk.ts'], runs: ['tests/intake-confirm-gate.test.ts', 'tests/intake-split-signal.test.ts'] })
  })

  it('a card that changes scripts/bus/review-worker.ts runs scripts/tests/bus/review-worker.test.ts without a person', () => {
    const w = world({
      'scripts/bus/review-worker.ts': 'export function runReviewWorker() {}\n',
      'scripts/tests/bus/review-worker.test.ts': 'import {\n  runReviewWorker,\n} from \'../../bus/review-worker.js\'\n',
      'scripts/tests/bus/merge-worker.test.ts': 'import { runMergeWorker } from \'../../bus/merge-worker.js\'\n',
      'scripts/bus/merge-worker.ts': 'export function runMergeWorker() {}\n',
    }, ['scripts/bus/review-worker.ts'])
    const bus: CardEvent[] = []
    expect(intake(w, event => bus.push(event)).status).toBe('written')
    expect(parked(w, bus)).toEqual({ touches: ['scripts/bus/review-worker.ts'], runs: ['scripts/tests/bus/review-worker.test.ts'] })
    expect(bus).toMatchObject([{ cardId: 13, payload: { confirmation: 'none' } }])
  })

  it('covering tests do not count toward the touches signal of the complexity seam', () => {
    const tests = Object.fromEntries(Array.from({ length: 8 }, (_, at) => [`scripts/tests/shift/part-${at}/covering.test.ts`, 'import { runShift } from \'../../../shift/shift.js\'\n']))
    const w = world({ 'scripts/shift/shift.ts': 'export function runShift() {}\n', ...tests }, ['scripts/shift/shift.ts'])
    expect(intake(w).status).toBe('written')
    expect(parked(w)).toEqual({ touches: ['scripts/shift/shift.ts'], runs: Object.keys(tests) })
    expect(readFileSync(path.join(w.parking, '13.md'), 'utf8')).not.toContain('seam: ')
  })

  it('covering tests do not raise a risk seam on a card whose own touches stand at one level', () => {
    const w = world({ 'src/materialize/plan.ts': 'export function plan() {}\n', 'scripts/tests/init-world.test.ts': 'import { plan } from \'../../src/materialize/plan.js\'\n' }, ['src/materialize/plan.ts'])
    expect(intake(w).status).toBe('written')
    expect(parked(w)).toEqual({ touches: ['src/materialize/plan.ts'], runs: ['scripts/tests/init-world.test.ts'] })
    const text = readFileSync(path.join(w.parking, '13.md'), 'utf8')
    expect(text).not.toContain('seam: risk')
    expect(text).not.toContain('slice: ')
  })

  it('a directory holding more than six covering tests is run as one mask', () => {
    const tests = Object.fromEntries(Array.from({ length: 7 }, (_, at) => [`scripts/tests/bus/covering-${at}.test.ts`, 'import { runReviewWorker } from \'../../bus/review-worker.js\'\n']))
    const w = world({ 'scripts/bus/review-worker.ts': 'export function runReviewWorker() {}\n', 'scripts/tests/ci/one.test.ts': 'import \'../../bus/review-worker.js\'\n', ...tests }, ['scripts/bus/review-worker.ts'])
    expect(intake(w).status).toBe('written')
    expect(parked(w)).toEqual({ touches: ['scripts/bus/review-worker.ts'], runs: ['scripts/tests/bus/**', 'scripts/tests/ci/one.test.ts'] })
  })
})
