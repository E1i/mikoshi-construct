import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { TreeCard, TreePr, TreePrPorts } from '../../nodes/launch/tree-pr.js'
import type { UpdateOutcome } from '../../nodes/update/update-executor.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { TreeRun } from '../../ports/git.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_AGENT } from '../../core/events.js'
import { GENERATED_FILES, RATCHET_FILE } from '../../core/generated-files.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { treePr } from '../../nodes/launch/tree-pr.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { grownEntries, judgeDerived, removesEntriesOnly } from '../../policy/derived-files.js'
import { DERIVED_REGISTRY, derivedHoldOf } from '../../policy/touch-scope.js'
import { treeReading } from '../../ports/git.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { ranTheGreenGate } from './gate-stream.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench } from './merge-bench.js'
import { detectUpdate } from './update-detection.js'

const runs = vi.hoisted(() => ({ fake: null as null | ((cwd: string, args: readonly string[]) => { status: number | null, stderr: string }) }))

vi.mock('../../ports/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ports/git.js')>()
  return { ...original, pnpmRerun: (cwd: string, args: readonly string[]) => runs.fake!(cwd, args) }
})

const KNOWN = GENERATED_FILES.knownViolations.path
const RATCHET = RATCHET_FILE.path
const MODULE_FILES = GENERATED_FILES.moduleFiles.path
const MODULE_OWNS = GENERATED_FILES.moduleOwns.path
const DECLARATIONS = 'declarations/modules'
const DECLARED = `${DECLARATIONS}/quality.json`
const TOUCHED = 'scripts/core/lease.ts'
const OTHER = 'scripts/core/other.ts'
const RULE = { severity: 'error', name: 'core-imports-nothing-to-its-right' }
const VIOLATIONS = [
  { type: 'dependency', from: TOUCHED, to: 'scripts/ports/meter.ts', rule: RULE },
  { type: 'dependency', from: OTHER, to: 'scripts/ports/meter.ts', rule: RULE },
  { type: 'dependency', from: TOUCHED, to: 'scripts/ports/github.ts', rule: RULE },
]
const RATCHET_ROW = 'boundary:core->ports'
const IMPORT_OF = (port: string): string => `import { ${port} } from '../ports/${port}.js'\n`
const WITH_METER = `${IMPORT_OF('meter')}\nexport const lease = meter\n`
const WITHOUT_METER = 'export const lease = 1\n'
const GROWN_LEASE = `${IMPORT_OF('meter')}${IMPORT_OF('github')}\nexport const lease = [meter, github]\n`
const NEW_GATE = 'scripts/core/quality-gate.ts'
const GATE = 'construct.json'
const AT_THE_BASE: Record<string, string> = {
  [GATE]: `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`,
  [TOUCHED]: WITH_METER,
  [OTHER]: `${IMPORT_OF('meter')}\nexport const other = meter\n`,
  [DECLARED]: `${JSON.stringify({ module: 'quality', paths: [KNOWN, OTHER] }, null, 2)}\n`,
  [`${DECLARATIONS}/factory-contract.json`]: `${JSON.stringify({ module: 'factory-contract', paths: [RATCHET] }, null, 2)}\n`,
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function read(tree: string, file: string): string {
  return readFileSync(path.join(tree, file), 'utf8')
}

function write(tree: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), text)
}

function importsIn(tree: string, file: string, port: string): boolean {
  return existsSync(path.join(tree, file)) && read(tree, file).includes(`'../ports/${port}.js'`)
}

const GENERATORS: readonly (readonly [readonly string[], (tree: string) => void])[] = [
  [GENERATED_FILES.knownViolations.rebuild, tree => write(tree, KNOWN, json(VIOLATIONS.filter(entry => importsIn(tree, entry.from, path.basename(entry.to, '.ts')))))],
  [RATCHET_FILE.rebuild, tree => write(tree, RATCHET, json({ [RATCHET_ROW]: [TOUCHED, OTHER].flatMap(file => existsSync(path.join(tree, file)) ? read(tree, file).match(/'\.\.\/ports\//g) ?? [] : []).length }))],
  [GENERATED_FILES.moduleFiles.rebuild, (tree) => {
    const owned = Object.fromEntries(readdirSync(path.join(tree, DECLARATIONS)).sort().map((file) => {
      const declared = JSON.parse(read(tree, `${DECLARATIONS}/${file}`)) as { module: string, paths: string[] }
      return [declared.module, [...declared.paths].sort()]
    }))
    write(tree, MODULE_FILES, json(owned))
    write(tree, MODULE_OWNS, `export const MODULE_OWNS = ${JSON.stringify(owned)}\n`)
  }],
]

function generate(tree: string, args: readonly string[]): { status: number | null, stderr: string } {
  const generator = GENERATORS.find(([command]) => command.join(' ') === args.join(' '))
  if (generator === undefined)
    return { status: 1, stderr: `no generator for ${args.join(' ')}` }
  generator[1](tree)
  return { status: 0, stderr: '' }
}

const fakeRerun: TreeRun = generate

function rebuildAll(tree: string): void {
  for (const [command] of GENERATORS)
    generate(tree, command)
}

type Scenario = (tree: string) => void

const NARROWS: Scenario = (tree) => {
  write(tree, TOUCHED, WITHOUT_METER)
  generate(tree, GENERATED_FILES.knownViolations.rebuild)
}

const DECLARES: Scenario = (tree) => {
  write(tree, DECLARED, json({ module: 'quality', paths: [KNOWN, OTHER, NEW_GATE] }))
  write(tree, NEW_GATE, 'export const gate = 1\n')
  generate(tree, GENERATED_FILES.moduleOwns.rebuild)
}

const HAND_EDITS: Scenario = (tree) => {
  write(tree, KNOWN, json(VIOLATIONS.slice(1, 2)))
}

const GROWS: Scenario = (tree) => {
  write(tree, TOUCHED, GROWN_LEASE)
  generate(tree, GENERATED_FILES.knownViolations.rebuild)
  generate(tree, RATCHET_FILE.rebuild)
}

const SCENARIOS = {
  narrows: { change: NARROWS, touches: [TOUCHED], outside: [KNOWN] },
  declares: { change: DECLARES, touches: [`${DECLARATIONS}/**`, NEW_GATE], outside: [MODULE_FILES, MODULE_OWNS] },
  handEdits: { change: HAND_EDITS, touches: [TOUCHED], outside: [KNOWN] },
  grows: { change: GROWS, touches: [TOUCHED], outside: [KNOWN, RATCHET] },
} as const

type ScenarioName = keyof typeof SCENARIOS

const roots: string[] = []
const benches: MergeBench[] = []

beforeEach(() => {
  runs.fake = fakeRerun
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  runs.fake = null
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function room(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'derived-files-follow-'))
  roots.push(root)
  return root
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function baseTree(tree: string): void {
  for (const [file, text] of Object.entries(AT_THE_BASE))
    write(tree, file, text)
  rebuildAll(tree)
  execFileSync('git', ['init', '-q', '-b', 'main', tree])
  gitIn(tree, ['add', '-A'])
  gitIn(tree, ['commit', '-q', '-m', 'base'])
  gitIn(tree, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
}

function cardText(cardId: number, touches: readonly string[]): string {
  return `card: #${cardId} derived-files-follow [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: shift\n\nChange the tree.\n`
}

function questionAgentStops(made: MergeBench): Record<string, unknown>[] {
  return eventsOf(made.db, CARD_STOPPED).filter(stop => stop.reason === QUESTION_AGENT)
}

function waitIds(made: MergeBench): unknown[] {
  return eventsOf(made.db, OWNER_WAIT_OPENED).map(wait => wait.id)
}

interface Launched {
  made: MergeBench
  opened: TreePr
  bodies: string[]
}

function launch(name: ScenarioName, waits = true): Launched {
  const scenario = SCENARIOS[name]
  const cardId = 4001
  const made = mergeBench()
  benches.push(made)
  const worktree = path.join(room(), `mc-${cardId}`)
  baseTree(worktree)
  const origin = path.join(path.dirname(worktree), 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  gitIn(worktree, ['remote', 'add', 'origin', origin])
  gitIn(worktree, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  gitIn(worktree, ['fetch', '-q', 'origin'])
  const card: TreeCard = { branch: `feat/card-${cardId}`, title: `derived-files-follow (#${cardId})`, commitMessage: `derived-files-follow (#${cardId})`, cardLine: cardText(cardId, scenario.touches).split('\n')[0]!, contour: 'cheap', touches: [...scenario.touches], runs: [], namedPathReason: null, cardId }
  gitIn(worktree, ['checkout', '-q', '-b', card.branch])
  scenario.change(worktree)
  const bodies: string[] = []
  const ports: TreePrPorts = {
    git: gitIn,
    gh: (args) => {
      if (args[1] === 'list')
        return '[]'
      bodies.push(args[args.indexOf('--body') + 1]!)
      return 'https://github.com/o/r/pull/1588\n'
    },
    ...(waits ? { ownerWait: (waiting: number | null, text: string) => openOwnerWait(made.db, made.clock.now().toISOString(), 'worker:shift:test', { need: 'decision', text, ...(waiting === null ? {} : { card: waiting }) }) } : {}),
  }
  return { made, opened: treePr(ports, card, worktree, null), bodies }
}

interface Answered {
  made: MergeBench
  outcome: AnswerOutcome
  published: number
  stopsBefore: number
}

async function answer(name: ScenarioName): Promise<Answered> {
  const scenario = SCENARIOS[name]
  const cardId = 4002
  const text = cardText(cardId, scenario.touches)
  const made = mergeBench()
  benches.push(made)
  const home = room()
  const worktree = path.join(home, `mc-${cardId}`)
  baseTree(worktree)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: `#${cardId}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${cardId}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: QUESTION_AGENT, detail: 'the tree changes' }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId, stop })
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease
  const heads = [sha('a'), sha('e')]
  let published = 0
  const answerer = claudeAnswerer(path.join(home, 'answers'), {
    cardText: () => text,
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      scenario.change(worktree)
      ranTheGreenGate(run)
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: () => {
      published += 1
    },
    pending: () => gitIn(worktree, ['ls-files', '--modified', '--others', '--exclude-standard']).split('\n').filter(file => file !== ''),
  })
  const trees: CardTreeTools = { home, exists: existsSync, branchOf: card => `feat/card-${card}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, dirty: () => false, liveSession: () => null, prepare: () => {} })
  const stopsBefore = questionAgentStops(made).length
  const outcome = await executor.answer(lease)
  return { made, outcome, published, stopsBefore }
}

interface Updated {
  made: MergeBench
  outcome: UpdateOutcome
}

function update(name: ScenarioName): Updated {
  const scenario = SCENARIOS[name]
  const pr = 4003
  const cardId = pr + 100
  const tree = path.join(room(), `mc-${cardId}`)
  baseTree(tree)
  gitIn(tree, ['checkout', '-q', '-b', `feat/card-${cardId}`])
  scenario.change(tree)
  gitIn(tree, ['add', '-A'])
  gitIn(tree, ['commit', '-q', '-m', 'card'])
  const head = gitIn(tree, ['rev-parse', 'HEAD']).trim()
  const made = liveBench()
  benches.push(made)
  const text = cardText(cardId, scenario.touches)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { text, textSha: textSha(text), lane: null, decision: 'owner', contour: 'cheap', depends: [] }, legacy: false })
  const changed = gitIn(tree, ['diff', '--name-only', 'origin/main', 'HEAD']).split('\n').filter(file => file !== '')
  made.gitHub.open({ number: pr, head, mergeable_state: 'dirty', files: changed })
  made.tick()
  detectUpdate(made)
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'update', 'worker:update:worker-1') as Lease
  const executor = new UpdateExecutor({
    silentMs: SILENT_MS,
    db: made.db,
    gitHub: made.gitHub.client,
    put: made.gitHub.put,
    publish: made.gitHub.publish,
    clock: made.clock.now,
    settle: () => {},
    mergeMain: () => ({ kind: 'merged', to: sha('m'), tookMain: [], rebuilt: [] }),
    derived: (_cardId, scope, files) => derivedHoldOf(scope, files, () => treeReading(gitIn, tree, 'origin/main', fakeRerun)),
  })
  return { made, outcome: executor.update(lease) }
}

describe('a derived file follows its source on tree-pr, answer and update (D-592)', () => {
  it('a derived change without growth passes on tree-pr, answer and update', async () => {
    const launched = launch('narrows')
    expect(launched.opened).toEqual({ kind: 'pr', number: '1588', followed: [KNOWN] })
    expect(waitIds(launched.made)).toEqual([])

    const answered = await answer('narrows')
    expect(answered.outcome).toMatchObject({ kind: 'answered' })
    expect(answered.published).toBe(1)
    expect(waitIds(answered.made)).toEqual([])

    const updated = update('narrows')
    expect(updated.outcome).toMatchObject({ kind: 'updated', to: sha('m') })
    expect(waitIds(updated.made)).toEqual([])
  })

  it('a generator output declared by the card passes on tree-pr, answer and update', async () => {
    const launched = launch('declares')
    expect(launched.opened).toEqual({ kind: 'pr', number: '1588', followed: [MODULE_FILES, MODULE_OWNS] })

    const answered = await answer('declares')
    expect(answered.outcome).toMatchObject({ kind: 'answered' })
    expect(answered.published).toBe(1)

    expect(update('declares').outcome).toMatchObject({ kind: 'updated' })
  })

  it('a hand edit of a derived file the rerun does not reproduce is refused on tree-pr, answer and update', async () => {
    const launched = launch('handEdits')
    expect(launched.opened).toMatchObject({ kind: 'problem', gaps: [{ reason: 'derived-unreproduced', paths: [KNOWN] }] })
    expect(launched.bodies).toEqual([])

    const answered = await answer('handEdits')
    expect(answered.published).toBe(0)
    expect(answered.outcome).not.toMatchObject({ kind: 'answered' })

    expect(update('handEdits').outcome).toMatchObject({ kind: 'denied', denial: { reason: 'derived_refused', detail: expect.stringContaining('does not reproduce') } })
  })

  it('growth of a derived file opens a numbered owner wait, not a question.agent stop, on tree-pr, answer and update', async () => {
    const launched = launch('grows')
    expect(launched.opened).toMatchObject({ kind: 'pr', number: '1588' })
    expect(launched.bodies[0]).toContain('Derived growth waits for the owner')
    expect(waitIds(launched.made)).toEqual([expect.stringMatching(/^Q\d+$/)])
    expect(questionAgentStops(launched.made)).toEqual([])

    const answered = await answer('grows')
    expect(answered.published).toBe(0)
    expect(answered.outcome).toMatchObject({ kind: 'stopped' })
    expect(waitIds(answered.made)).toEqual([expect.stringMatching(/^Q\d+$/)])
    expect(questionAgentStops(answered.made)).toHaveLength(answered.stopsBefore)

    const updated = update('grows')
    expect(updated.outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
    expect(waitIds(updated.made)).toEqual([expect.stringMatching(/^Q\d+$/)])
    expect(questionAgentStops(updated.made)).toEqual([])
  })

  it('growth on a tree-pr with no owner wait to open is refused, never passed silently', () => {
    const launched = launch('grows', false)
    expect(launched.opened).toMatchObject({ kind: 'problem', gaps: [{ reason: 'derived-unreproduced', paths: [KNOWN, RATCHET] }] })
    expect(launched.bodies).toEqual([])
    expect(waitIds(launched.made)).toEqual([])
  })

  it('a refused derived file is never offered to the owner as a path to widen the touches to', async () => {
    const answered = await answer('handEdits')
    const stops = eventsOf(answered.made.db, CARD_STOPPED).slice(answered.stopsBefore)
    expect(stops).not.toEqual([])
    for (const stop of stops)
      expect(stop.widen ?? []).not.toContain(KNOWN)
  })
})

describe('the judgement of a derived file (D-592, narrowing D-514 to growth)', () => {
  it('a narrowed or removed entry is not growth, a new entry, an altered entry or a grown row is', () => {
    const [stale, kept, grown] = VIOLATIONS.map(entry => JSON.stringify(entry))
    expect(grownEntries(json(VIOLATIONS.slice(0, 2)), json(VIOLATIONS.slice(1, 2)))).toEqual([])
    expect(grownEntries(json(VIOLATIONS.slice(0, 2)), json(VIOLATIONS))).toEqual([grown])
    expect(grownEntries(json(VIOLATIONS.slice(0, 2)), json([{ ...VIOLATIONS[0], to: 'scripts/ports/github.ts' }, VIOLATIONS[1]]))).toEqual([JSON.stringify({ ...VIOLATIONS[0], to: 'scripts/ports/github.ts' })])
    expect(grownEntries(json({ [RATCHET_ROW]: 2 }), json({ [RATCHET_ROW]: 1 }))).toEqual([])
    expect(grownEntries(json({ [RATCHET_ROW]: 2 }), json({ [RATCHET_ROW]: 3 }))).toEqual([`${RATCHET_ROW} (2 → 3)`])
    expect(grownEntries(json({}), json({ [RATCHET_ROW]: 1 }))).toEqual([`${RATCHET_ROW} (new: 1)`])
    expect(grownEntries(json({ [RATCHET_ROW]: 2, [`lines:${TOUCHED}`]: 40 }), json({ [RATCHET_ROW]: 2, [`lines:${TOUCHED}`]: 39 }))).toEqual([])
    expect(removesEntriesOnly(json([JSON.parse(stale!), JSON.parse(kept!)]), json([JSON.parse(kept!)]))).toBe(true)
  })

  it('a new output file is checked against the declarations and its owner module', () => {
    const tree = room()
    for (const [file, text] of Object.entries(AT_THE_BASE))
      write(tree, file, text)
    rebuildAll(tree)
    const reading = { current: (file: string) => existsSync(path.join(tree, file)) ? read(tree, file) : null, base: () => null, rerun: () => ({ kind: 'ran' as const, outputs: new Map([[RATCHET, read(tree, RATCHET)]]) }) }
    expect(judgeDerived(DERIVED_REGISTRY, [RATCHET], reading)).toMatchObject({ followed: [], grown: [{ file: RATCHET }] })

    const unowned = json({ ...JSON.parse(read(tree, MODULE_FILES)) as Record<string, string[]>, 'factory-contract': [] })
    const withoutTheOutput = { ...reading, current: (file: string) => file === MODULE_FILES ? unowned : reading.current(file) }
    expect(judgeDerived(DERIVED_REGISTRY, [RATCHET], withoutTheOutput).refused).toEqual([{ file: RATCHET, why: expect.stringContaining(`${MODULE_FILES} built from the declarations does not give it to its owner module factory-contract`) }])

    rmSync(path.join(tree, DECLARATIONS, 'factory-contract.json'))
    expect(judgeDerived(DERIVED_REGISTRY, [RATCHET], reading).refused).toEqual([{ file: RATCHET, why: expect.stringContaining('owner module factory-contract has no declaration') }])
  })

  it('a derived file not marked measure does not grow, even by a new row', () => {
    const before = json({ quality: [KNOWN, OTHER] })
    const after = json({ 'quality': [KNOWN, OTHER], 'card-record': [NEW_GATE] })
    expect(grownEntries(before, after)).toEqual([`card-record (new: ${JSON.stringify([NEW_GATE])})`])
    const reading = { current: (file: string) => file === MODULE_FILES ? after : null, base: () => before, rerun: () => ({ kind: 'ran' as const, outputs: new Map([[MODULE_FILES, after]]) }) }
    expect(judgeDerived(DERIVED_REGISTRY, [MODULE_FILES], reading)).toEqual({ followed: [MODULE_FILES], refused: [], grown: [] })
  })

  it('a generator that cannot run on the card\'s tree refuses its output, and the tree is left as it was', () => {
    const tree = room()
    baseTree(tree)
    HAND_EDITS(tree)
    const before = read(tree, KNOWN)
    const failing: TreeRun = () => ({ status: 2, stderr: 'depcruise: not found' })
    expect(judgeDerived(DERIVED_REGISTRY, [KNOWN], treeReading(gitIn, tree, 'origin/main', failing)).refused).toEqual([{ file: KNOWN, why: expect.stringContaining('depcruise: not found') }])
    expect(judgeDerived(DERIVED_REGISTRY, [KNOWN], treeReading(gitIn, tree, 'origin/main', fakeRerun)).refused).toEqual([{ file: KNOWN, why: expect.stringContaining('does not reproduce') }])
    expect(read(tree, KNOWN)).toBe(before)
  })
})

describe('the rerun runs only a registered derived-file rebuild (D-648)', () => {
  it('a command off the closed list of rebuilds is refused and never spawned', async () => {
    const { pnpmRerun } = await vi.importActual<typeof import('../../ports/git.js')>('../../ports/git.js')
    const tree = room()
    const marker = path.join(tree, 'spawned')
    const offList = ['exec', 'node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]
    const registeredWithAnExtraArgument = [...RATCHET_FILE.rebuild, '--write', marker]
    for (const args of [offList, registeredWithAnExtraArgument]) {
      const result = pnpmRerun(tree, args)
      expect(result.status).toBeNull()
      expect(result.stderr).toContain('is not a registered derived-file rebuild')
    }
    expect(existsSync(marker)).toBe(false)
  })
})
