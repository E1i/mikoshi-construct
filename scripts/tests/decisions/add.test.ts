import type { OwnerDecision } from '../../bus/decisions.js'
import { describe, expect, it } from 'vitest'
import { ARCHIVE_HEADER, runDecisionsAdd } from '../../decisions/add.js'
import { DECISIONS_IN_FORCE_LIMIT, decisionsRefusals } from '../../decisions/decisions.js'
import { runDecisionsRead } from '../../decisions/read.js'

const FILE = '/d/owner-decisions.md'
const ARCHIVE = '/d/owner-decisions.archive.md'
const NOW = new Date('2026-10-09T09:12:40Z')
const HEADER = '# Owner decisions\n\nAppend-only.\n\n'

function decisionsFile(...lines: string[]): string {
  return `${HEADER}${lines.join('\n')}\n`
}

function add(files: Record<string, string>, args: string[], failingWrite = 0): { code: number, out: string[], err: string[], files: Record<string, string>, writes: number, recorded: OwnerDecision[] } {
  const state = { ...files }
  const out: string[] = []
  const err: string[] = []
  const recorded: OwnerDecision[] = []
  let writes = 0
  const code = runDecisionsAdd(['--file', FILE, ...args], {
    home: '/home/x',
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
    out: line => out.push(line),
    err: line => err.push(line),
  })
  return { code, out, err, files: state, writes, recorded }
}

function decisionsRead(files: Record<string, string>): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runDecisionsRead([FILE], {
    home: '/home/x',
    journal: '/h/ghosts.jsonl',
    exists: file => file in files,
    read: file => files[file]!,
    write: () => {},
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

  it('an overflow the archive removes is written', () => {
    const before = decisionsFile(long(1), long(2), long(3))
    expect(decisionsRefusals(`${before}${long(4)}\n`)).toHaveLength(1)
    const result = add({ [FILE]: before }, ['--supersedes', 'D-1', `[owner] ${'four '.repeat(400)}`])
    expect(result.code).toBe(0)
    expect(result.files[ARCHIVE]).toBe(`${ARCHIVE_HEADER}${long(1).trimEnd()} · superseded-by D-4\n`)
    expect(result.files[FILE]).not.toContain('- D-1 ')
    expect(decisionsRead(result.files).code).toBe(0)
  })

  it('an overflow the archive does not remove is refused and leaves the file unchanged', () => {
    const before = decisionsFile(long(1), long(2, ' · superseded-by D-3'), long(3))
    const result = add({ [FILE]: before }, [`[owner] ${'four '.repeat(1000)}`])
    expect(result.code).toBe(1)
    expect(result.writes).toBe(0)
    expect(result.recorded).toEqual([])
    expect(result.err).toHaveLength(1)
    expect(result.err[0]).toMatch(new RegExp(`^\\[decisions\\] decisions in force would be \\d+ bytes, over the limit of ${DECISIONS_IN_FORCE_LIMIT} after the superseded ones go to the archive; nothing written$`))
    expect(result.files).toEqual({ [FILE]: before })
  })

  it('refuses a flag it does not know, no record, two records and a missing file', () => {
    expect(add({}, ['--all', '[owner] x.']).code).toBe(2)
    expect(add({}, []).code).toBe(2)
    expect(add({}, ['[owner] x.', '[owner] y.']).code).toBe(2)
    expect(add({}, ['--supersedes', 'D-01', '[owner] x.']).code).toBe(2)
    expect(add({}, ['[owner] x.']).err).toEqual([`[decisions] no decisions at ${FILE}`])
  })
})
