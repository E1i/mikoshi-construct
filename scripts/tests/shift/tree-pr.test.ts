import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { CardStarter } from '../../nodes/launch/launch-executor.js'
import type { PrOpenedBus, TreePrCliPorts } from '../../nodes/launch/tree-pr-cli.js'
import type { TreeCard, TreePrPorts } from '../../nodes/launch/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { LaunchNode, noPullRequestDetail } from '../../nodes/launch/launch-worker.js'
import { reduce } from '../../core/reducer.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, CARD_VERIFIED, CARD_WAITING } from '../../core/events.js'
import { busCardReturned, busCardStopped, busCardText, busCardWaited, busLastRefusal, busPrOpened, PREFIX, runTreePr } from '../../nodes/launch/tree-pr-cli.js'
import { reportClosingOf, treePr } from '../../nodes/launch/tree-pr.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const CARD: TreeCard = {
  branch: 'feat/x',
  title: 'x (#1)',
  commitMessage: 'x (#1)',
  cardLine: '#1 x [implement/infra/S/cheap/auto] · depends — · blocks —',
  contour: 'cheap',
  touches: ['scripts/x.ts'],
  runs: [],
  namedPathReason: null,
}

function untouchable(): never {
  throw new Error('no call is expected')
}

const UNREFUSED = { stopped: untouchable, waited: untouchable, lastRefusal: untouchable, returned: untouchable, resume: untouchable }

function repoWithoutOrigin(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-'))
  roots.push(root)
  execFileSync('git', ['-C', root, 'init', '-q'])
  return root
}

describe('treePr', () => {
  it('a failed push reports git stderr in the problem', () => {
    const worktree = repoWithoutOrigin()
    const ports: TreePrPorts = {
      git: (cwd, args) => {
        if (args[0] === 'fetch' || args[0] === 'merge' || args[0] === 'status')
          return ''
        if (args[0] === 'rev-list')
          return '1\n'
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      },
      gh: () => {
        throw new Error('no gh call is expected')
      },
    }
    const result = treePr(ports, CARD, worktree, null)
    expect(result.kind).toBe('problem')
    expect(result.kind === 'problem' && result.why).toMatch(/^the shift could not commit, push or open the pull request of feat\/x: Command failed: git -C .+ push -q -u origin HEAD:refs\/heads\/feat\/x: error: src refspec HEAD does not match any · error: failed to push some refs to 'origin'$/)
  })
})

describe('tree-pr reads its card from the bus', () => {
  const CARD_TEXT = parkingFileText({ card: '#951 x [implement/netwatch/S/cheap/auto] · depends — · blocks —', branch: 'feat/x', touches: ['docs/x.md'], continue: 'stop', who: 'shift', body: 'Do x.' })

  function busWithCard(root: string): string {
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    try {
      appendEvent(db, { ts: '2026-10-21T00:00:00.000Z', type: CARD_ADMITTED, actor: 'policy', cardId: 951, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:951`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'admission-951', text: CARD_TEXT, textSha: textSha(CARD_TEXT) }, legacy: false })
      reduce(db)
    }
    finally {
      db.close()
    }
    return busPath
  }

  function docsOnlyPorts(bodies: string[]): TreePrPorts {
    return {
      git: (_cwd, args) => {
        if (args[0] === 'rev-list')
          return '1\n'
        if (args[0] === 'show' && args[1] === 'HEAD:package.json')
          return JSON.stringify({ files: ['dist', 'templates'] })
        if (args.includes('--name-status'))
          return 'M\0docs/x.md\0'
        if (args.includes('--numstat'))
          return '1\t0\tdocs/x.md\0'
        return ''
      },
      gh: (args) => {
        if (args[1] === 'list')
          return '[]'
        bodies.push(args[args.indexOf('--body') + 1]!)
        return 'https://github.com/o/r/pull/901\n'
      },
    }
  }

  it('tree-pr opens the pull request when the card file moved during the session', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-'))
    roots.push(root)
    const busPath = busWithCard(root)
    const parked = path.join(root, 'parking', 'lane-a', '951.md')
    mkdirSync(path.dirname(parked), { recursive: true })
    writeFileSync(parked, CARD_TEXT)
    mkdirSync(path.join(root, 'parking', 'lane-b'))
    renameSync(parked, path.join(root, 'parking', 'lane-b', '951.md'))
    const bodies: string[] = []
    const opened: [number, number][] = []
    const lines: string[] = []

    const code = runTreePr(['951', root], { ...docsOnlyPorts(bodies), card: busCardText(busPath), opened: (cardId, pr) => opened.push([cardId, pr]), ...UNREFUSED }, line => lines.push(line))

    expect({ code, lines, opened, cardLine: bodies.map(body => body.split('\n')[0]) }).toEqual({ code: 0, lines: [`${PREFIX}card #951: PR #901`], opened: [[951, 901]], cardLine: ['#951 x [implement/netwatch/S/cheap/auto] · depends — · blocks —'] })
  })

  it('the bus port reads no body of a card the bus never admitted, and creates no bus file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-'))
    roots.push(root)
    const busPath = busWithCard(root)
    const absent = path.join(root, 'no-bus.db')

    expect({ admitted: busCardText(busPath)(951), other: busCardText(busPath)(952), absent: busCardText(absent)(951), created: existsSync(absent) }).toEqual({ admitted: CARD_TEXT, other: null, absent: null, created: false })
  })
})

describe('a session that ends without a pull request', () => {
  const REPORT = '#1232 a-probe [probe/netwatch/M/cheap/none] · depends — · blocks —\nresult: report written\nno PR\nverification: run\nReport: /probes/a-probe/report.md\n'
  const benches: { close: () => void }[] = []

  afterEach(() => {
    for (const made of benches.splice(0))
      made.close()
  })

  async function endedSession(cardId: number, kind: 'probe' | 'implement'): Promise<{ node: LaunchNode, made: ReturnType<typeof mergeBench> }> {
    const made = mergeBench()
    benches.push(made)
    const line = `#${cardId} card-${cardId} [${kind}/netwatch/M/cheap/${kind === 'probe' ? 'none' : 'auto'}] · depends — · blocks —`
    const text = parkingFileText({ card: line, branch: `feat/card-${cardId}`, touches: ['docs/x.md'], continue: 'stop', who: 'shift', body: 'Do the card.' })
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: kind === 'probe' ? 'none' : 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}`, text, textSha: textSha(text) }, legacy: false })
    made.tick()
    const starter: CardStarter = { start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }), stop: () => {} }
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new LaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, reportOf: () => REPORT, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    made.tick()
    return { node, made }
  }

  it('a probe card that ended with a report is card.done with the report and no fault', async () => {
    const { node, made } = await endedSession(1232, 'probe')

    expect(node.stopOverdue()).toEqual([])
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, CARD_VERIFIED)).toMatchObject([{ report: '/probes/a-probe/report.md', verification: 'run', session: 's-1232' }])
  })

  it('a working card without a pull request is not done', async () => {
    const { node, made } = await endedSession(1240, 'implement')

    expect(reportClosingOf(REPORT)).not.toBeNull()
    expect(node.stopOverdue()).toEqual([1240])
    expect(eventsOf(made.db, CARD_VERIFIED)).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', detail: noPullRequestDetail(1240, 's-1240', null) }])
  })

  it('a report closes a card only with a report path and a verification word', () => {
    expect([REPORT, REPORT.replace('verification: run', 'verification: guess'), REPORT.replace(/^Report:.*$/m, ''), null].map(reportClosingOf)).toEqual([{ report: '/probes/a-probe/report.md', verification: 'run' }, null, null, null])
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
}

function committer(repo: string): void {
  git(repo, ['config', 'user.email', 'shift@example.com'])
  git(repo, ['config', 'user.name', 'shift'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
}

interface CardTree {
  root: string
  worktree: string
  moveMain: (files: Record<string, string>) => void
}

function cardTree(): CardTree {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-base-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const worktree = path.join(root, 'tree')
  const upstream = path.join(root, 'upstream')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', worktree])
  committer(worktree)
  write(worktree, { 'docs/x.md': 'base\n', 'docs/y.md': 'base\n' })
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-q', '-m', 'base'])
  git(worktree, ['remote', 'add', 'origin', origin])
  git(worktree, ['push', '-q', 'origin', 'main'])
  git(worktree, ['fetch', '-q', 'origin'])
  git(worktree, ['checkout', '-q', '-b', 'feat/x'])
  execFileSync('git', ['clone', '-q', origin, upstream])
  committer(upstream)
  const moveMain = (files: Record<string, string>): void => {
    write(upstream, files)
    git(upstream, ['add', '-A'])
    git(upstream, ['commit', '-q', '-m', 'main moved'])
    git(upstream, ['push', '-q', 'origin', 'main'])
  }
  return { root, worktree, moveMain }
}

const OPENED_PR = 954

function openingGh(created = `https://github.com/o/r/pull/${OPENED_PR}\n`): TreePrPorts['gh'] {
  return (args) => {
    if (args[1] === 'list')
      return '[]'
    if (args[1] === 'create')
      return created
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
}

function cardText(contour: 'cheap' | 'ladder', touches: string[]): string {
  return parkingFileText({ card: `#951 x [implement/netwatch/S/${contour}/auto] · depends — · blocks —`, branch: 'feat/x', touches, continue: 'stop', who: 'shift', body: 'Do x.' })
}

function launchedBus(root: string, cardIds: number[]): PrOpenedBus {
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  for (const cardId of cardIds)
    appendEvent(db, { ts: '2026-10-22T04:00:00.000Z', type: CARD_STARTED, actor: 'worker:launch:1', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:launch:${cardId}:1`, payload: {}, legacy: false })
  db.close()
  return { busPath, pid: 4242, now: () => new Date('2026-10-22T05:00:00.000Z'), err: untouchable }
}

type BusPorts = Omit<TreePrCliPorts, 'git' | 'gh' | 'resume'>

function busPorts(bus: PrOpenedBus, text: string): BusPorts {
  return {
    card: cardId => cardId === 951 ? text : null,
    opened: busPrOpened(bus),
    stopped: busCardStopped(bus),
    waited: busCardWaited(bus),
    lastRefusal: busLastRefusal(bus.busPath),
    returned: busCardReturned(bus),
  }
}

interface Refused {
  type: string
  reason: string
  code: string
  pr?: number
}

function refusalsOf(busPath: string, cardId: number): Refused[] {
  const db = openBus(busPath)
  const rows = db.prepare(`SELECT type, pr, payload FROM events WHERE card_id = ? AND type IN ('${CARD_WAITING}', '${CARD_STOPPED}', 'pr.opened') ORDER BY id`).all(cardId) as { type: string, pr: number | null, payload: string }[]
  db.close()
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as { reason?: string, code?: string }
    return row.type === 'pr.opened' ? { type: row.type, reason: '', code: '', pr: row.pr! } : { type: row.type, reason: payload.reason!, code: payload.code! }
  })
}

const RETURNED = (code: string): Refused => ({ type: CARD_WAITING, reason: 'tree-pr-return', code })
const WAITED = (code: string): Refused => ({ type: CARD_STOPPED, reason: 'question.agent', code })
const PR = { type: 'pr.opened', reason: '', code: '', pr: OPENED_PR }

describe('a stale base is not a stop', () => {
  it('main moved ahead without a conflict: the pull request opens on the fresh base with no card.stopped and no fault', () => {
    const tree = cardTree()
    write(tree.worktree, { 'docs/x.md': 'mine\n' })
    tree.moveMain({ 'docs/y.md': 'theirs\n' })
    const bus = launchedBus(tree.root, [951])

    const code = runTreePr(['951', tree.worktree], { ...busPorts(bus, cardText('cheap', ['docs/x.md'])), git, gh: openingGh(), resume: untouchable }, () => {})

    const fresh = git(tree.worktree, ['rev-parse', 'origin/main']).trim()
    expect({
      code,
      events: refusalsOf(bus.busPath, 951),
      pushedOnFreshBase: git(tree.worktree, ['merge-base', 'origin/main', 'origin/feat/x']).trim() === fresh,
      merges: git(tree.worktree, ['rev-list', '--merges', '--count', 'origin/main..origin/feat/x']).trim(),
    }).toEqual({ code: 0, events: [PR], pushedOnFreshBase: true, merges: '1' })
  })

  it('a merge conflict the session did not resolve is a question, not a fault', () => {
    const tree = cardTree()
    write(tree.worktree, { 'docs/x.md': 'mine\n' })
    tree.moveMain({ 'docs/x.md': 'theirs\n' })
    const bus = launchedBus(tree.root, [951])
    const prompts: string[] = []

    const code = runTreePr(['951', tree.worktree], { ...busPorts(bus, cardText('cheap', ['docs/x.md'])), git, gh: openingGh(), resume: (_cardId, _worktree, prompt) => prompts.push(prompt) > 0 }, () => {})

    expect({ code, events: refusalsOf(bus.busPath, 951), returns: prompts.length, task: prompts[0]?.includes(`merge origin/main; merge, not rebase), resolve every conflict in docs/x.md`), midMerge: git(tree.worktree, ['status', '--porcelain']) }).toEqual({ code: 1, events: [RETURNED('a:stale-base'), WAITED('a:stale-base')], returns: 1, task: true, midMerge: '' })
  })

  it('the base moved twice in a row: no second return, a wait instead', () => {
    const tree = cardTree()
    write(tree.worktree, { 'docs/x.md': 'mine\n' })
    tree.moveMain({ 'docs/x.md': 'theirs\n' })
    const bus = launchedBus(tree.root, [951])
    let returns = 0
    const mergeAsTheSession = (): boolean => {
      returns += 1
      try {
        git(tree.worktree, ['merge', '-q', 'origin/main'])
      }
      catch {}
      write(tree.worktree, { 'docs/x.md': 'mine and theirs\n' })
      git(tree.worktree, ['add', '-A'])
      git(tree.worktree, ['commit', '-q', '--no-edit'])
      tree.moveMain({ 'docs/x.md': 'theirs again\n' })
      return true
    }

    const code = runTreePr(['951', tree.worktree], { ...busPorts(bus, cardText('cheap', ['docs/x.md'])), git, gh: openingGh(), resume: mergeAsTheSession }, () => {})

    expect({ code, events: refusalsOf(bus.busPath, 951), returns }).toEqual({ code: 1, events: [RETURNED('a:stale-base'), WAITED('a:stale-base')], returns: 1 })
  })
})

describe('a fresh base merge that does not go through is never a fault', () => {
  it('a merge that fails without a conflict returns the card to its session with the git failure, then waits, and writes no fault', () => {
    const tree = cardTree()
    write(tree.worktree, { 'docs/x.md': 'mine\n' })
    const orphan = path.join(tree.root, 'orphan')
    execFileSync('git', ['init', '-q', '-b', 'main', orphan])
    committer(orphan)
    write(orphan, { 'docs/z.md': 'another history\n' })
    git(orphan, ['add', '-A'])
    git(orphan, ['commit', '-q', '-m', 'another history'])
    git(orphan, ['push', '-q', '--force', path.join(tree.root, 'origin.git'), 'main'])
    const bus = launchedBus(tree.root, [951])
    const prompts: string[] = []

    const code = runTreePr(['951', tree.worktree], { ...busPorts(bus, cardText('cheap', ['docs/x.md'])), git, gh: openingGh(), resume: (_cardId, _worktree, prompt) => prompts.push(prompt) > 0 }, () => {})

    expect({ code, events: refusalsOf(bus.busPath, 951), returns: prompts.length, failure: prompts[0]?.includes('refusing to merge unrelated histories') }).toEqual({ code: 1, events: [RETURNED('a:stale-base'), WAITED('a:stale-base')], returns: 1, failure: true })
  })

  it('a merge the session left unconcluded is not committed with its conflict markers and pushes nothing', () => {
    const tree = cardTree()
    write(tree.worktree, { 'docs/x.md': 'mine\n' })
    tree.moveMain({ 'docs/x.md': 'theirs\n' })
    const bus = launchedBus(tree.root, [951])
    const leaveTheMergeOpen = (): boolean => {
      try {
        git(tree.worktree, ['merge', '-q', 'origin/main'])
      }
      catch {}
      return true
    }

    const code = runTreePr(['951', tree.worktree], { ...busPorts(bus, cardText('cheap', ['docs/x.md'])), git, gh: openingGh(), resume: leaveTheMergeOpen }, () => {})

    expect({ code, events: refusalsOf(bus.busPath, 951), pushed: git(tree.worktree, ['ls-remote', 'origin', 'feat/x']).trim(), committedMarkers: git(tree.worktree, ['show', 'HEAD:docs/x.md']).includes('<<<<<<<') }).toEqual({ code: 1, events: [RETURNED('a:stale-base'), WAITED('a:stale-base')], pushed: '', committedMarkers: false })
  })
})

interface DiffState {
  files: { path: string, status?: string }[]
}

function diffGit(state: DiffState): TreePrPorts['git'] {
  return (_cwd, args) => {
    if (args[0] === 'rev-list')
      return '1\n'
    if (args[0] === 'show' && args[1] === 'HEAD:package.json')
      return JSON.stringify({ files: ['dist', 'templates'] })
    if (args.includes('--name-status'))
      return state.files.map(file => `${file.status ?? 'M'}\0${file.path}\0`).join('')
    if (args.includes('--numstat'))
      return state.files.map(file => `1\t0\t${file.path}\0`).join('')
    return ''
  }
}

const SCRIPT = 'scripts/shift/x.ts'
const TOUCHES = [SCRIPT, 'src/x.ts', 'src/y.ts', '.changeset/**']
const MATRIX_LINE = '■ 3 □ 1 · 6\n'

function reportIn(prompt: string): string {
  return /update the shift report (\S+),/.exec(prompt)![1]!
}

describe('a refusal the session can fix returns the card to it once', () => {
  function settled(contour: 'cheap' | 'ladder', state: DiffState, resume: TreePrCliPorts['resume'], gh = openingGh()) {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-return-'))
    roots.push(root)
    const bus = launchedBus(root, [951])
    const report = path.join(root, 'report-951.md')
    const code = runTreePr(['951', root, report], { ...busPorts(bus, cardText(contour, TOUCHES)), git: diffGit(state), gh, resume }, () => {})
    return { code, bus, events: refusalsOf(bus.busPath, 951) }
  }

  it('a cheap card without a D-76 line gets no no-d76-line gap', () => {
    const { code, events } = settled('cheap', { files: [{ path: SCRIPT }] }, untouchable)

    expect({ code, events }).toEqual({ code: 0, events: [PR] })
  })

  it('a test outside touches is a wait for the window and the session leaves touches unchanged', () => {
    const outside = 'scripts/tests/other/y.test.ts'
    const { code, bus } = settled('ladder', { files: [{ path: SCRIPT }, { path: outside }] }, untouchable)

    const db = openBus(bus.busPath)
    const waits = (db.prepare(`SELECT payload FROM events WHERE card_id = 951 AND type = '${CARD_STOPPED}'`).all() as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
    db.close()
    expect({ code, waits: waits.map(({ reason, code: reasonCode, widen, touches }) => ({ reason, code: reasonCode, widen, touches })), returns: refusalsOf(bus.busPath, 951).filter(event => event.type === CARD_WAITING) }).toEqual({ code: 1, waits: [{ reason: 'question.agent', code: 'b:outside-touches', widen: [outside], touches: TOUCHES }], returns: [] })
  })

  it('the same reason code twice in a row with a different text: no second return, a wait', () => {
    const state: DiffState = { files: [{ path: 'src/x.ts' }] }
    let returns = 0
    const { code, events } = settled('ladder', state, () => {
      returns += 1
      state.files = [{ path: 'src/y.ts' }]
      return true
    })

    const code2 = 'a:no-changeset+no-matrix-line'
    expect({ code, events, returns }).toEqual({ code: 1, events: [RETURNED(code2), WAITED(code2)], returns: 1 })
  })

  it('the same reason code twice in a row with another card refused in between: no second return, a wait', () => {
    let returns = 0
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-return-'))
    roots.push(root)
    const bus = launchedBus(root, [951, 952])
    const ports = busPorts(bus, cardText('ladder', TOUCHES))
    const code = runTreePr(['951', root], { ...ports, git: diffGit({ files: [{ path: 'src/x.ts' }] }), gh: openingGh(), resume: () => {
      returns += 1
      ports.stopped(952, 'gh pr create printed no pull request URL', 'c:no-pr-url')
      return true
    } }, () => {})

    expect({ code, events: refusalsOf(bus.busPath, 951), other: refusalsOf(bus.busPath, 952), returns }).toEqual({ code: 1, events: [RETURNED('a:no-changeset+no-matrix-line'), WAITED('a:no-changeset+no-matrix-line')], other: [{ type: CARD_STOPPED, reason: 'fault', code: 'c:no-pr-url' }], returns: 1 })
  })

  it('two different reasons in a row each get their own return', () => {
    const state: DiffState = { files: [{ path: '.changeset/x.md', status: 'A' }, { path: 'src/x.ts' }] }
    const fixes = [
      (report: string) => {
        writeFileSync(report, MATRIX_LINE)
        state.files = [{ path: 'src/x.ts' }]
      },
      () => {
        state.files = [{ path: '.changeset/x.md', status: 'A' }, { path: 'src/x.ts' }]
      },
    ]
    const { code, events } = settled('cheap', state, (_cardId, _worktree, prompt) => {
      fixes.shift()!(reportIn(prompt))
      return true
    })

    expect({ code, events, unused: fixes.length }).toEqual({ code: 0, events: [RETURNED('a:no-matrix-line'), RETURNED('a:no-changeset'), PR], unused: 0 })
  })

  it('a class c refusal stops the card as before', () => {
    const { code, events } = settled('ladder', { files: [{ path: SCRIPT }] }, untouchable, openingGh('nothing\n'))

    expect({ code, events }).toEqual({ code: 1, events: [{ type: CARD_STOPPED, reason: 'fault', code: 'c:no-pr-url' }] })
  })
})
