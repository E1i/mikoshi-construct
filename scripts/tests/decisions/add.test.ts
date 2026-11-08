import type { OwnerDecision } from '../../policy/decisions.js'
import type { RequestTools } from '../../window/window-requests.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardAdmissions, busCardEvents } from '../../intake/intake.js'
import { ARCHIVE_HEADER, requestDecision, runDecisionsAdd } from '../../policy/decisions/add.js'
import { runDecisionsRead } from '../../policy/decisions/read.js'
import { pendingRequests, WindowRequests } from '../../window/window-requests.js'

const FILE = '/d/owner-decisions.md'
const ARCHIVE = '/d/owner-decisions.archive.md'
const NOW = new Date('2026-10-09T09:12:40Z')
const HEADER = '# Owner decisions\n\nAppend-only.\n\n'

function decisionsFile(...lines: string[]): string {
  return `${HEADER}${lines.join('\n')}\n`
}

function add(files: Record<string, string>, args: string[], failingWrite = 0, settled: (card: number) => boolean = () => false): { code: number, out: string[], err: string[], files: Record<string, string>, writes: number, recorded: OwnerDecision[] } {
  const state = { ...files }
  const out: string[] = []
  const err: string[] = []
  const recorded: OwnerDecision[] = []
  let writes = 0
  const code = runDecisionsAdd(['--file', FILE, ...args], {
    decisions: '/home/x/.construct/owner-decisions.md',
    now: () => NOW,
    exists: file => file in state,
    read: file => state[file]!,
    write: (file, text) => {
      writes += 1
      if (writes === failingWrite)
        throw new Error(`EACCES: ${file}`)
      state[file] = text
    },
    remove: (file) => {
      delete state[file]
    },
    record: decision => recorded.push(decision),
    settled,
    out: line => out.push(line),
    err: line => err.push(line),
  })
  return { code, out, err, files: state, writes, recorded }
}

function decisionsRead(files: Record<string, string>): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runDecisionsRead([FILE], {
    decisions: '/home/x/.construct/owner-decisions.md',
    history: [],
    bus: new Map(),
    exists: file => file in files,
    read: file => files[file]!,
    out: line => out.push(line),
    err: line => err.push(line),
  })
  return { code, out, err }
}

const long = (number: number, tail = ''): string => `- D-${number} · 2026-10-08 — ${`decision ${number} `.repeat(240)}${tail}`

describe('pnpm decisions:add appends one owner decision', () => {
  it('appends the next D-N and the file still passes pnpm decisions', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one.', '- D-2 · 2026-10-08 ~17:40Z — two.')
    const result = add({ [FILE]: before }, ['[owner] #753 stays owner-merged.'])
    const line = '- D-3 · 2026-10-09 ~09:12Z — [owner] #753 stays owner-merged. · decisions:add'
    expect(result).toMatchObject({ code: 0, out: [line], err: [] })
    expect(result.files[FILE]).toBe(`${before}${line}\n`)
    expect(result.files[ARCHIVE]).toBeUndefined()
    expect(result.recorded).toEqual([{ ts: NOW.toISOString(), decisionId: 3, text: '#753 stays owner-merged.', cards: [] }])
    expect(decisionsRead(result.files)).toEqual({ code: 0, out: ['- D-1 · 2026-10-08 — one.', '- D-2 · 2026-10-08 ~17:40Z — two.', line], err: [] })
  })

  it('names the cards of --card in the card tail and in the recorded scope', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one.')
    const result = add({ [FILE]: before }, ['--card', '#807', '--card', '808', '[owner] both stay owner-merged.'])
    expect(result.out).toEqual(['- D-2 · 2026-10-09 ~09:12Z — [owner] both stay owner-merged. · card #807 #808 · decisions:add'])
    expect(result.recorded.map(decision => decision.cards)).toEqual([[807, 808]])
    expect(decisionsRead(result.files).code).toBe(0)
    expect(add({ [FILE]: before }, ['--card', 'x', '[owner] y.']).code).toBe(2)
  })

  it('writes --until as the until tail of the line and of the recorded text, and refuses a term that is not a calendar instant', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one.')
    const result = add({ [FILE]: before }, ['--card', '#837', '--until', '2026-10-12T04:30Z', '[owner] delegated.'])
    expect(result.out).toEqual(['- D-2 · 2026-10-09 ~09:12Z — [owner] delegated. · card #837 · until 2026-10-12T04:30Z · decisions:add'])
    expect(result.recorded.map(decision => decision.text)).toEqual(['delegated. · until 2026-10-12T04:30Z'])
    expect(decisionsRead(result.files)).toMatchObject({ code: 0, err: [] })
    for (const until of ['2026-10-12', '2026-02-30T00:00Z', '2026-10-12T04:30Z.'])
      expect(add({ [FILE]: before }, ['--until', until, '[owner] y.']).code).toBe(2)
  })

  it('a line the check refuses leaves the file unchanged', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one. · superseded-by D-2', '- D-2 · 2026-10-08 — two.')
    const result = add({ [FILE]: before }, ['[owner] three, superseded-by D-1 later.'])
    expect(result.code).toBe(1)
    expect(result.err.at(-1)).toBe(`[decisions] D-3 refused: 1 refusals, ${FILE} restored as it was`)
    expect(result.files).toEqual({ [FILE]: before })
    expect(result.recorded).toEqual([])
  })

  it('a record whose source is not owner is refused', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one.')
    for (const record of ['[operator] the owner wants #753 merged.', 'the owner wants #753 merged.', '[owner]', '[mikoshi] [owner] paraphrase.']) {
      const result = add({ [FILE]: before }, [record])
      expect(result.code, record).toBe(1)
      expect(result.writes, record).toBe(0)
      expect(result.recorded, record).toEqual([])
      expect(result.err[0], record).toMatch(/^\[decisions\] (?:the source \[\w*\]|no source|an empty record): decisions:add writes only the owner's own words/)
    }
  })

  it('marks a decision named by --supersedes and moves every superseded one to the archive', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one. · superseded-by D-2', '- D-2 · 2026-10-08 — two.', '- D-3 · 2026-10-08 — three. · card #753')
    const result = add({ [FILE]: before }, ['--supersedes', 'D-3', '[owner] three, as the owner says.'])
    expect(result.code).toBe(0)
    expect(result.files[ARCHIVE]).toBe(`${ARCHIVE_HEADER}- D-1 · 2026-10-08 — one. · superseded-by D-2\n- D-3 · 2026-10-08 — three. · card #753 · superseded-by D-4\n`)
    expect(result.files[FILE]).toBe(decisionsFile('- D-2 · 2026-10-08 — two.', '- D-4 · 2026-10-09 ~09:12Z — [owner] three, as the owner says. · decisions:add'))
    expect(decisionsRead(result.files).code).toBe(0)
    const next = add(result.files, ['[owner] five.'])
    expect(next.out[0]).toBe('- D-5 · 2026-10-09 ~09:12Z — [owner] five. · decisions:add')
    expect(decisionsRead(next.files).code).toBe(0)
  })

  it('a decisions file write that throws after the archive write restores both and records nothing', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one. · superseded-by D-2', '- D-2 · 2026-10-08 — two.')
    const result = add({ [FILE]: before }, ['[owner] three.'], 2)
    expect(result.code).toBe(1)
    expect(result.err).toEqual([`[decisions] D-3 not written: EACCES: ${FILE}; ${FILE} restored as it was`])
    expect(result.files).toEqual({ [FILE]: before })
    expect(result.recorded).toEqual([])
    expect(decisionsRead(result.files).code).toBe(0)
  })

  it('archives a decision --supersedes names that is already superseded, and refuses one not in the file', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one. · card #753 · superseded-by D-2', '- D-2 · 2026-10-08 — spent.')
    expect(add({ [FILE]: before }, ['--supersedes', 'D-1', '[owner] one again.']).files[ARCHIVE]).toContain('- D-1 · 2026-10-08 — one. · card #753 · superseded-by D-2\n')
    const missing = add({ [FILE]: before }, ['--supersedes', 'D-9', '[owner] nine.'])
    expect(missing).toMatchObject({ code: 1, writes: 0, err: ['[decisions] --supersedes D-9: not a decision in the file; nothing written'] })
  })

  it('decisions in force of any size are written', () => {
    const before = decisionsFile(long(1), long(2, ' · superseded-by D-3'), long(3))
    const result = add({ [FILE]: before }, [`[owner] ${'four '.repeat(1000).trim()}`])
    expect(result).toMatchObject({ code: 0, err: [] })
    expect(result.recorded.map(decision => decision.decisionId)).toEqual([4])
    expect(decisionsRead(result.files).code).toBe(0)
  })

  it('after decisions:add a lapsed decision line is gone from the decisions file and present in the archive', () => {
    const lapsed = '- D-1 · 2026-10-08 — one. · until 2026-10-09T08:00Z'
    const before = decisionsFile(lapsed, '- D-2 · 2026-10-08 — two. · until 2026-10-10T08:00Z')
    const result = add({ [FILE]: before }, ['[owner] three.'])
    expect(result.code).toBe(0)
    expect(result.files[ARCHIVE]).toBe(`${ARCHIVE_HEADER}${lapsed}\n`)
    expect(result.files[FILE]).toBe(decisionsFile('- D-2 · 2026-10-08 — two. · until 2026-10-10T08:00Z', '- D-3 · 2026-10-09 ~09:12Z — [owner] three. · decisions:add'))
    expect(result.out).toContain(`[decisions] D-1 moved to ${ARCHIVE}`)
    expect(decisionsRead(result.files)).toMatchObject({ code: 0, err: [] })
  })

  it('a decision whose until does not read is never archived by decisions:add: the add is refused and the file stays as it was', () => {
    const before = decisionsFile('- D-1 · 2026-10-08 — one. · until 2026-10-09T08:00')
    const result = add({ [FILE]: before }, ['[owner] two.'])
    expect(result.code).toBe(1)
    expect(result.files).toEqual({ [FILE]: before })
    expect(result.err.join('\n')).toContain('D-1 on line')
  })

  it('after decisions:add a card-spent decision line is gone from the decisions file and present in the archive', () => {
    const archived = Array.from({ length: 54 }, (_, index) => `- D-${index + 1} · 2026-10-08 — archived ${index + 1}.\n`).join('')
    const spent = '- D-55 · 2026-10-08 — five. · card #753'
    const before = decisionsFile(spent, '- D-56 · 2026-10-08 — six. · card #754')
    const result = add({ [FILE]: before, [ARCHIVE]: `${ARCHIVE_HEADER}${archived}` }, ['[owner] seven.'], 0, card => card === 753)
    expect(result.code).toBe(0)
    expect(result.files[ARCHIVE]).toBe(`${ARCHIVE_HEADER}${archived}${spent}\n`)
    expect(result.files[FILE]).not.toContain(spent)
    expect(result.files[FILE]).toContain('- D-56 · 2026-10-08 — six. · card #754\n')
    expect(result.out[0]).toBe('- D-57 · 2026-10-09 ~09:12Z — [owner] seven. · decisions:add')
    expect(decisionsRead(result.files)).toMatchObject({ code: 0, err: [] })
  })

  it('refuses a flag it does not know, no record, two records and a missing file', () => {
    expect(add({}, ['--all', '[owner] x.']).code).toBe(2)
    expect(add({}, []).code).toBe(2)
    expect(add({}, ['[owner] x.', '[owner] y.']).code).toBe(2)
    expect(add({}, ['--supersedes', 'D-01', '[owner] x.']).code).toBe(2)
    expect(add({}, ['[owner] x.']).err).toEqual([`[decisions] no decisions at ${FILE}`])
  })
})

describe('pnpm decisions:add in a window session asks the bus', () => {
  it('queues a window.request, says the decision is not written yet, and refuses --file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'decisions-request-'))
    const db = openBus(path.join(root, 'bus.db'))
    try {
      const out: string[] = []
      expect(requestDecision(['--from', 'answer', '--file', FILE, '[owner] x.'], db, NOW, 'window-1', line => out.push(line))).toBe(2)
      expect(pendingRequests(db)).toEqual([])
      expect(out.some(line => line.includes('not written yet'))).toBe(false)

      const asked: string[] = []
      expect(requestDecision(['--from', 'answer', '--card', '#5', '[owner] x.'], db, NOW, 'window-1', line => asked.push(line))).toBe(0)
      const [request] = pendingRequests(db)
      expect(JSON.parse(request!.payload)).toEqual({ kind: 'decisions:add', text: '[owner] x.', from: 'answer', cards: ['#5'], supersedes: [] })
      expect(asked.at(-1)).toBe(`[decisions] not written yet: window.request ${request!.id} waits for bus:run, which records it in the bus, rebuilds owner-decisions.md from the bus and answers window.request.done or window.request.refused; while bus:run is down nothing is written`)
    }
    finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a card decision that requires a new file adds it to the touches of the card', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'decisions-creates-'))
    const repo = path.join(root, 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    writeFileSync(path.join(repo, 'src/a.ts'), '')
    const db = openBus(path.join(root, 'bus.db'))
    try {
      const text = 'card: #5 card-5 [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-5\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n'
      busCardEvents(db, 's1', () => 3)({ type: CARD_ADMITTED, cardId: 5, ts: NOW.toISOString(), dedupeKey: 'admit-5', payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends: [], decision: 'auto', contour: 'cheap', bodySha: textSha(text), text, textSha: textSha(text) } })
      reduce(db)
      const out: string[] = []
      expect(requestDecision(['--from', 'answer', '--card', '#5', '--creates', 'src/new.ts', '[owner] the card writes src/new.ts.'], db, NOW, 'window-1', line => out.push(line)), out.join('\n')).toBe(0)
      expect(pendingRequests(db).map(request => (JSON.parse(request.payload) as { kind: string }).kind)).toEqual(['amend', 'decisions:add'])
      expect(JSON.parse(pendingRequests(db)[1]!.payload)).toMatchObject({ kind: 'decisions:add', text: '[owner] the card writes src/new.ts.', cards: ['#5'] })
      new WindowRequests(db, () => NOW, { closeDropped: () => [] } as unknown as RequestTools, path.join(root, 'channel'), () => null, repo, {} as never).run()
      reduce(db)
      const body = busCardAdmissions(db)(5)!.text!
      expect(body).toMatch(/^touches: src\/a\.ts, src\/new\.ts$/m)
      expect(body).toMatch(/^creates: src\/new\.ts$/m)
      expect(requestDecision(['--from', 'answer', '--creates', 'src/other.ts', '[owner] no card.'], db, NOW, 'window-1', () => {})).toBe(2)
      expect(pendingRequests(db)).toHaveLength(0)
    }
    finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
