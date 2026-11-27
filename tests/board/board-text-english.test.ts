import type { CardDetail } from '../../scripts/cli/board-page.js'
import type { CardFields } from '../../scripts/intake/card-contract.js'
import type { BusCard, BusFacts, OwnerWait } from '../../src/commands/board/bus.js'
import { describe, expect, it } from 'vitest'
import { renderBoard } from '../../scripts/cli/board-page.js'
import { boardWarnings } from '../../scripts/cli/board-warnings.js'
import { isLive, screenLines, taskTally } from '../../src/commands/board/screens.js'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'

const AT = '2026-11-13T10:00:00.000Z'
const CYRILLIC = /\p{Script=Cyrillic}/u
const TASK = 30

const STATE_OF_STAGE: Readonly<Record<BusCard['stage'], string>> = { 'planned': 'queued', 'queue': 'queued', 'in work': 'running', 'review': 'in_review', 'answer/changes': 'changes', 'ready': 'ready', 'merged': 'merged', 'stopped': 'stopped', 'dropped': 'dropped' }

function card(id: number, stage: BusCard['stage'], lane: string | null, parent?: BusCard['parent']): BusCard {
  return { id, state: STATE_OF_STAGE[stage], stage, lane, line: `#${id} card-${id} [implement/construct/S/cheap/auto] · depends — · blocks —`, since: AT, body: true, closed: false, closedAt: null, ...parent === undefined ? {} : { parent } }
}

const CARDS: BusCard[] = [
  card(10, 'planned', 'lane-1'),
  card(18, 'queue', null),
  card(11, 'in work', 'lane-2'),
  card(12, 'review', null),
  card(13, 'answer/changes', 'lane-1'),
  card(14, 'ready', 'lane-1'),
  card(15, 'stopped', 'lane-2'),
  card(16, 'merged', null),
  card(31, 'merged', 'lane-1', { card: TASK, part: 1, of: 2 }),
  card(32, 'in work', 'lane-2', { card: TASK, part: 2, of: 2 }),
]

const OWNER_WAIT: OwnerWait = { id: 'Q1', need: 'decision', text: 'pick the route', command: 'construct answer Q1 "words"', card: 32, pr: 501, since: AT, lifter: 'owner', decision: null }
const MERGE_WAIT: OwnerWait = { ...OWNER_WAIT, id: 'Q2', need: 'merge', text: 'merge the version PR', card: 14, pr: 502 }
const WINDOW_WAIT: OwnerWait = { ...OWNER_WAIT, id: 'Q3', need: 'command', text: 'restart the bus', card: null, pr: null, lifter: 'window' }

const EVERY_BLOCK: BusFacts = {
  at: AT,
  goal: {
    plans: [{
      id: 'release-1',
      title: 'Release one',
      goal: 'ship the board',
      delivered: 1,
      total: 4,
      remainder: 3,
      stages: { queued: 1, in_progress: 1, review: 1, delivered: 1 },
      cards: [{ card: 10, mark: 'queued' }, { card: 11, mark: 'in_progress' }, { card: 12, mark: 'review' }, { card: 16, mark: 'delivered' }, { card: 17, mark: 'dropped' }],
      gate: { word: 'release', status: 'due' },
      deliveredRecently: 1,
    }],
    backlog: 2,
  },
  waits: [OWNER_WAIT, MERGE_WAIT, WINDOW_WAIT],
  waitsStale: 'owner_waits behind by 3 events',
  cardsStale: 'cards behind by 2 events',
  pulse: '2026-11-13T09:59:00.000Z',
  slots: [{ queue: 'review', used: 1, total: 3 }, { queue: 'answer', used: 0, total: null }],
  cards: CARDS,
  services: [
    { role: 'window', task: 'operator', tree: null, step: 'awake', session: 's1', gauges: { context: 120_000, spent: 3, model: 'claude-opus-5-5' }, subagents: [{ name: 'implementer', context: 40_000, spent: 1, at: AT }] },
    { role: 'review', task: '#12', tree: 'trees/12', step: 'reading', gauges: { context: null, spent: null, model: null } },
  ],
  matrices: [{ pr: 501, head: 'abc1234', full: '■ 3 □ 1 · 2', killed: 3, survived: 1, notRun: 2 }],
  failure: 'bus read failed: disk full',
  reviewQueue: 2,
  groups: [{ prs: [501, 502], modules: ['board', 'bus'], turn: 501 }],
  shadow: { needsUpdate: 1, needsVerification: 2 },
  tails: [{ card: 16, pr: 503, head: 'def5678', finding: 'a test left behind' }],
}

const CONTRACT: CardFields = {
  id: 11,
  name: 'card-11',
  kind: 'implement',
  milestone: 'construct',
  size: 'S',
  contour: 'cheap',
  decision: 'auto',
  depends: [],
  blocks: [],
  cardLine: '#11 card-11 [implement/construct/S/cheap/auto] · depends — · blocks —',
  branch: 'feat/card-11',
  touches: ['src/a.ts'],
  continue: 'stop',
  who: 'shift',
  priority: 'p2',
  release: null,
  creates: [],
  prose: 'The board shows the card.',
  witnesses: ['W1 the board shows the card'],
  witnessFields: [],
  runs: ['tests/board/**'],
  masks: [],
  unclear: ['which lane'],
  risk: null,
  seam: [],
  slice: [],
  path: 'cheap',
  lane: 'lane-2',
  text: 'The board shows the card.',
  textSha: 'abc',
  admissionEventId: 1,
  state: 'running',
  lastHeartbeat: null,
}

const DETAIL: CardDetail = {
  contract: CONTRACT,
  chain: null,
  pr: 501,
  witnessTable: null,
  runs: { full: null, groups: [{ name: 'tests/board/**', files: [], derived: false }], paths: ['tests/board/**'] },
}

function page(facts: BusFacts): string {
  return renderBoard({
    version: '0.47.0',
    machine: { load: 2.5, cores: 8 },
    liveness: 'live',
    modelVersion: 6,
    facts,
    windowGauges: null,
    limits: { contextLimit: 200_000, cardContextLine: 150_000, sessionSpend: 10, agentSpend: 5, warnRatio: 0.8, modelWindows: new Map() },
    details: new Map(CARDS.map(each => [each.id, DETAIL])),
    decisions: { stale: null, rows: [], at: 0 },
    handoff: { file: 'miko.md', text: 'next: the board card' },
    repository: 'owner/repo',
    tickMs: 30_000,
    warnings: boardWarnings({ contexts: [{ who: 'window', context: 190_000 }, { who: 'card #11', context: 250_000 }], contextLimit: 200_000, warnRatio: 0.8, openPrs: 6, openPrLimit: 5, ownerWaits: 2, stalls: ['#11 in work, no event for 40 minutes'], savingOff: true, stalePasses: 2 }),
  })
}

function cyrillicLines(text: string): string[] {
  return text.split('\n').filter(line => CYRILLIC.test(line))
}

describe('the board prints no Cyrillic', () => {
  it('the board page on a fixture with every kind of block has no Cyrillic character', () => {
    const html = page(EVERY_BLOCK)
    expect(html).toContain('whole folder')
    expect(cyrillicLines(html)).toEqual([])
  })

  it('construct board, plain and in lore, on a fixture with every kind of block has no Cyrillic character', () => {
    for (const lore of [PLAIN_LORE, LORE])
      expect(cyrillicLines(screenLines(EVERY_BLOCK, lore, true).join('\n'))).toEqual([])
  })

  it('counts read 1 card and 1 task for one, N cards and N tasks for more', () => {
    const one: BusFacts = { ...EVERY_BLOCK, cards: [card(10, 'in work', 'lane-1')], goal: null }
    expect(screenLines(one, PLAIN_LORE).join('\n')).toContain('1 card = 1 task')
    expect(page(one)).toContain('1 card = 1 task')
    const tally = taskTally(CARDS.filter(isLive))
    const many = `${tally.cards} cards = ${tally.tasks} tasks`
    expect(tally.cards).toBeGreaterThan(1)
    expect(tally.tasks).toBeGreaterThan(1)
    expect(screenLines(EVERY_BLOCK, PLAIN_LORE, true).join('\n')).toContain(many)
    expect(page(EVERY_BLOCK)).toContain(many)
  })
})
