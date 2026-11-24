import type { Lease } from '../../core/lease.js'
import type { TreeCard } from '../../nodes/launch/tree-pr.js'
import type { UpdateOutcome } from '../../nodes/update/update-executor.js'
import type { DerivedReading, GrownDerived } from '../../policy/derived-files.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TestCoverage } from '../../../src/card/covering-tests.js'
import { textSha } from '../../../src/card/text-sha.js'
import { closedWaitTextsOf } from '../../core/card-readings.js'
import { appendEvent, closeOwnerWait, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, OWNER_WAIT_OPENED } from '../../core/events.js'
import { RATCHET_FILE } from '../../core/generated-files.js'
import { leaseNext } from '../../core/lease.js'
import { all as pullRequests } from '../../core/pr-readings.js'
import { busClosedWaitTexts } from '../../nodes/launch/launch-root.js'
import { answerFollowed, derivedSplit, ownerHeardOn, treePr } from '../../nodes/launch/tree-pr.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { derivedGrowthLine, growthAskedBefore, growthToAsk } from '../../policy/derived-files.js'
import { cardAllowances, cardTransitions, derivedHolds, updateParts } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const RATCHET = RATCHET_FILE.path
const ROW = 'boundary:core->ports'
const TOUCHED = 'scripts/core/lease.ts'
const PR = 4203
const CARD = PR + 100
const ALLOWS_3 = `allow ${RATCHET} ${ROW} 2 -> 3`
const SCRIPTS = 'scripts'
const GROWTH_JUDGEMENT = /\b(?:derivedGrowthLine|derivedHoldOf|derivedSplit|answerFollowed|grownForTheOwner|growthToAsk|unallowedGrowth|derivedHolds)\b/

const NODES_THAT_ASK_ABOUT_GROWTH: Record<string, { files: readonly string[], readsTheCard: RegExp }> = {
  launch: { files: ['scripts/nodes/launch/tree-pr.ts'], readsTheCard: /growthToAsk\(verdict\.grown, allowances, closedWaitTexts\)/ },
  update: { files: ['scripts/nodes/update/update-executor.ts', 'scripts/nodes/update/update-worker.ts', 'scripts/supervisor/composition.ts'], readsTheCard: /allowances\(cardId\)/ },
  answer: { files: ['scripts/nodes/answer/answerer.ts'], readsTheCard: /request\.allowances/ },
}
const LAUNCH_PORTS = { file: 'scripts/nodes/launch/tree-pr-cli.ts', readsTheBus: /allowances: busAllowances\(REAL_BUS\.busPath\),\s+closedWaitTexts: busClosedWaitTexts\(REAL_BUS\.busPath\)/ }
const JUDGES = ['scripts/policy/derived-files.ts', 'scripts/policy/touch-scope.ts']

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function ratchet(value: number): string {
  return json({ [ROW]: value })
}

function growth(from: number, to: number): GrownDerived[] {
  return [{ file: RATCHET, entries: [`${ROW} (${from} → ${to})`] }]
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'tests' ? [] : sourcesUnder(at)
    return entry.name.endsWith('.ts') ? [at] : []
  })
}

const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function treeGrownTo(to: number): string {
  const tree = mkdtempSync(path.join(tmpdir(), 'growth-asked-once-'))
  roots.push(tree)
  mkdirSync(path.join(tree, path.dirname(RATCHET)), { recursive: true })
  writeFileSync(path.join(tree, RATCHET), ratchet(to))
  return tree
}

function baseGit(from: number): (cwd: string, args: string[]) => string {
  return (_cwd, args) => {
    if (args[0] === 'show' && args[1]?.endsWith(`:${RATCHET}`))
      return ratchet(from)
    if (args[0] === 'show')
      throw new Error(`no ${args[1]} at the base`)
    return ''
  }
}

const reproduces = (): { status: number, stderr: string } => ({ status: 0, stderr: '' })

function readingOf(from: number, to: number): DerivedReading {
  const current = (file: string): string | null => file === RATCHET ? ratchet(to) : null
  return { current, base: file => file === RATCHET ? ratchet(from) : null, rerun: (_command, outputs) => ({ kind: 'ran', outputs: new Map(outputs.map(file => [file, current(file)])) }) }
}

function cardText(cardId: number): string {
  return `card: #${cardId} growth-asked-once [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nChange the tree.\n`
}

function allows(text: string): (made: MergeBench) => void {
  return made => recordDecision(made.db, { ts: made.clock.now().toISOString(), decisionId: 2145, text, cards: [CARD] })
}

function askedAndClosed(text: string, card = CARD): (made: MergeBench) => void {
  return (made) => {
    const ts = made.clock.now().toISOString()
    const id = openOwnerWait(made.db, ts, 'worker:shift:test', { need: 'decision', text, card, pr: card === CARD ? PR : PR + 1 })
    closeOwnerWait(made.db, ts, 'owner', id, 'answered', 1)
  }
}

function update(from: number, to: number, decide: (made: MergeBench) => void = () => {}): { made: MergeBench, outcome: UpdateOutcome } {
  const made = liveBench()
  benches.push(made)
  const text = cardText(CARD)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { text, textSha: textSha(text), lane: null, decision: 'owner', contour: 'cheap', depends: [] }, legacy: false })
  made.gitHub.open({ number: PR, head: sha('c'), mergeable_state: 'dirty', files: [TOUCHED, RATCHET] })
  decide(made)
  made.tick()
  detectUpdate(made)
  const lease = leaseNext(made.db, pullRequests(made.db), made.clock.now().toISOString(), 'update', 'worker:update:worker-1') as Lease
  const executor = new UpdateExecutor({ cards: cardTransitions(), source: updateParts(), silentMs: SILENT_MS, db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, mergeMain: () => ({ kind: 'merged', to: sha('m'), tookMain: [], rebuilt: [] }), derived: derivedHolds(made.db, () => readingOf(from, to)) })
  return { made, outcome: executor.update(lease) }
}

function waitTexts(made: MergeBench): unknown[] {
  return eventsOf(made.db, OWNER_WAIT_OPENED).map(wait => wait.text)
}

function launchGrown(from: number, to: number, allowances: readonly string[], closed: readonly string[] = []): GrownDerived[] {
  return derivedSplit(baseGit(from), treeGrownTo(to), [RATCHET], reproduces, allowances, closed).grown
}

function answerOutside(from: number, to: number, allowances: readonly string[]): string[] {
  return answerFollowed(baseGit(from), treeGrownTo(to), [RATCHET], CARD, cardText(CARD), new TestCoverage(() => [], () => null), undefined, reproduces, allowances).outside
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function writeIn(tree: string, file: string, text: string): void {
  mkdirSync(path.join(tree, path.dirname(file)), { recursive: true })
  writeFileSync(path.join(tree, file), text)
}

function launchedTree(from: number, to: number): string {
  const home = mkdtempSync(path.join(tmpdir(), 'growth-asked-once-launch-'))
  roots.push(home)
  const tree = path.join(home, `mc-${CARD}`)
  writeIn(tree, 'construct.json', json({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } }))
  writeIn(tree, TOUCHED, 'export const lease = 1\n')
  writeIn(tree, RATCHET, ratchet(from))
  execFileSync('git', ['init', '-q', '-b', 'main', tree])
  gitIn(tree, ['add', '-A'])
  gitIn(tree, ['commit', '-q', '-m', 'base'])
  const origin = path.join(home, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  gitIn(tree, ['remote', 'add', 'origin', origin])
  gitIn(tree, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  gitIn(tree, ['fetch', '-q', 'origin'])
  gitIn(tree, ['checkout', '-q', '-b', `feat/card-${CARD}`])
  writeIn(tree, TOUCHED, 'export const lease = 2\n')
  writeIn(tree, RATCHET, ratchet(to))
  return tree
}

function launchedWaits(from: number, to: number, decide: (made: MergeBench) => void): string[] {
  const made = mergeBench()
  benches.push(made)
  decide(made)
  made.tick()
  const tree = launchedTree(from, to)
  const card: TreeCard = { branch: `feat/card-${CARD}`, title: `growth-asked-once (#${CARD})`, commitMessage: `growth-asked-once (#${CARD})`, cardLine: cardText(CARD).split('\n')[0]!, contour: 'cheap', touches: [TOUCHED], runs: [], namedPathReason: null, cardId: CARD }
  const opened: string[] = []
  const launched = treePr({ git: gitIn, rebuild: reproduces, gh: args => args[1] === 'list' ? '[]' : `https://github.com/o/r/pull/${PR}\n`, ownerWait: (_card, text) => String(opened.push(text)), allowances: () => [], closedWaitTexts: busClosedWaitTexts(made.busPath) }, card, tree, null)
  expect(launched).toMatchObject({ kind: 'pr', number: String(PR) })
  return opened
}

describe('the owner is asked about a derived growth once per card, row and value (F-owner-growth-answer-lost-on-update-loop)', () => {
  it('every node that asks the owner about a growth reads the card allowances first', () => {
    const named = new Set(Object.values(NODES_THAT_ASK_ABOUT_GROWTH).flatMap(node => node.files))
    const judging = sourcesUnder(SCRIPTS).filter(file => !JUDGES.includes(file) && GROWTH_JUDGEMENT.test(readFileSync(file, 'utf8')))
    expect(judging.sort()).toEqual([...named].sort())
    for (const [node, { files, readsTheCard }] of Object.entries(NODES_THAT_ASK_ABOUT_GROWTH))
      expect(files.some(file => readsTheCard.test(readFileSync(file, 'utf8'))), node).toBe(true)
    expect(readFileSync(LAUNCH_PORTS.file, 'utf8')).toMatch(LAUNCH_PORTS.readsTheBus)

    expect(ownerHeardOn({ allowances: card => card === CARD ? [ALLOWS_3] : [], closedWaitTexts: card => card === CARD ? ['asked'] : [] }, CARD)).toEqual({ allowances: [ALLOWS_3], closedWaitTexts: ['asked'] })
    expect(ownerHeardOn({ allowances: () => [ALLOWS_3] }, undefined)).toEqual({ allowances: [], closedWaitTexts: [] })
    expect(launchGrown(2, 3, [ALLOWS_3])).toEqual([])
    expect(answerOutside(2, 3, [ALLOWS_3])).toEqual([])
    const updated = update(2, 3, allows(ALLOWS_3))
    expect(updated.outcome).toMatchObject({ kind: 'updated', to: sha('m') })
    expect(waitTexts(updated.made)).toEqual([])
    expect(cardAllowances(updated.made.db)(CARD)).toEqual([ALLOWS_3])
  })

  it('a growth question with the same row and value as a closed wait of the card is not opened again', () => {
    const asked = `card #${CARD}, pull request #${PR} at ${sha('b')}: ${derivedGrowthLine(growth(2, 3))}`
    expect(growthAskedBefore(derivedGrowthLine(growth(1, 3)), [asked])).toBe(true)
    expect(growthToAsk(growth(1, 3), [], [asked])).toEqual([])
    expect(launchGrown(1, 3, [], [asked])).toEqual([])
    expect(launchedWaits(1, 3, askedAndClosed(asked))).toEqual([])
    expect(launchedWaits(1, 3, askedAndClosed(asked, CARD + 1))).toEqual([expect.stringContaining(`${ROW} (1 → 3)`)])

    const updated = update(1, 3, askedAndClosed(asked))
    expect(closedWaitTextsOf(updated.made.db, CARD)).toEqual([asked])
    expect(updated.outcome).toMatchObject({ kind: 'updated', to: sha('m') })
    expect(waitTexts(updated.made)).toEqual([asked])

    const stillOpen = update(1, 3, made => openOwnerWait(made.db, made.clock.now().toISOString(), 'worker:shift:test', { need: 'decision', text: asked, card: CARD, pr: PR }))
    expect(closedWaitTextsOf(stillOpen.made.db, CARD)).toEqual([])
    expect(stillOpen.outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
  })

  it('a growth above the allowed value still asks the owner', () => {
    expect(launchGrown(2, 4, [ALLOWS_3])).toEqual(growth(2, 4))
    expect(answerOutside(2, 4, [ALLOWS_3])).toEqual([RATCHET])
    const above = update(2, 4, allows(ALLOWS_3))
    expect(above.outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
    expect(waitTexts(above.made)).toEqual([expect.stringContaining(`${ROW} (2 → 4)`)])

    const askedAt3 = `card #${CARD}: ${derivedGrowthLine(growth(2, 3))}`
    expect(growthAskedBefore(derivedGrowthLine(growth(2, 4)), [askedAt3])).toBe(false)
    expect(growthToAsk(growth(2, 4), [], [askedAt3])).toEqual(growth(2, 4))
    expect(launchGrown(2, 4, [], [askedAt3])).toEqual(growth(2, 4))
    const askedLower = update(2, 4, askedAndClosed(askedAt3))
    expect(askedLower.outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
    expect(waitTexts(askedLower.made)).toHaveLength(2)

    const anotherCard = `card #${CARD + 1}: ${derivedGrowthLine(growth(2, 3))}`
    const otherCardAsked = update(2, 3, askedAndClosed(anotherCard, CARD + 1))
    expect(closedWaitTextsOf(otherCardAsked.made.db, CARD + 1)).toEqual([anotherCard])
    expect(closedWaitTextsOf(otherCardAsked.made.db, CARD)).toEqual([])
    expect(otherCardAsked.outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
  })
})
