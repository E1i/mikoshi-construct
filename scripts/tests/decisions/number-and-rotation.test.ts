import type { OwnerDecision } from '../../policy/decisions.js'
import type { DecisionRow } from '../../policy/decisions/decisions.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARCHIVE_HEADER, lockFileOf, planAdd, runDecisionsAdd, takeFileLock } from '../../policy/decisions/add.js'
import { decisionsRefusals, parseDecisions, projectDecisions } from '../../policy/decisions/decisions.js'

const FILE = '/d/owner-decisions.md'
const ARCHIVE = '/d/owner-decisions.archive.md'
const NOW = new Date('2026-11-05T11:52:00Z')
const HEADER = '# Owner decisions\n\nA projection of the decisions table in the bus.\n\n'

function decisionsFile(...lines: string[]): string {
  return `${HEADER}${lines.join('\n')}\n`
}

interface Run {
  code: number
  out: string[]
  err: string[]
}

interface Hooks {
  beforeLock?: () => void
  afterRead?: () => void
  afterWrite?: () => void
  record?: (decision: OwnerDecision) => void
}

interface Shared {
  state: Record<string, string>
  recorded: OwnerDecision[]
  locked: boolean
}

function shared(state: Record<string, string>): Shared {
  return { state, recorded: [], locked: false }
}

function adder(bus: Shared, hooks: Hooks = {}): (args: string[]) => Run {
  const { state, recorded } = bus
  return (args) => {
    const out: string[] = []
    const err: string[] = []
    let firstRead = true
    let firstWrite = true
    const code = runDecisionsAdd(['--file', FILE, ...args], {
      decisions: FILE,
      now: () => NOW,
      exists: file => file in state,
      lock: (file) => {
        hooks.beforeLock?.()
        if (bus.locked)
          return `[decisions] ${file}.lock is held by another decisions:add; nothing written, run it again`
        bus.locked = true
        return () => {
          bus.locked = false
        }
      },
      read: (file) => {
        const text = state[file]!
        if (file === FILE && firstRead) {
          firstRead = false
          hooks.afterRead?.()
        }
        return text
      },
      write: (file, text) => {
        state[file] = text
        if (file === FILE && firstWrite) {
          firstWrite = false
          hooks.afterWrite?.()
        }
      },
      remove: (file) => {
        delete state[file]
      },
      record: (decision) => {
        hooks.record?.(decision)
        if (recorded.some(each => each.decisionId === decision.decisionId))
          throw new Error(`decision.recorded:${decision.decisionId} is already in the bus`)
        recorded.push(decision)
      },
      held: () => recorded.map(decision => decision.decisionId),
      settled: () => false,
      out: line => out.push(line),
      err: line => err.push(line),
    })
    return { code, out, err }
  }
}

function refusalsOf(state: Record<string, string>): string[] {
  return decisionsRefusals(state[FILE]!, state[ARCHIVE] ?? '')
}

function numbersIn(text: string | undefined): number[] {
  return parseDecisions(text ?? '').decisions.map(decision => decision.number)
}

const ONE = '- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add'

describe('a decision number is issued once', () => {
  it('two concurrent decisions:add get different numbers', () => {
    const bus = shared({ [FILE]: decisionsFile(ONE) })
    let second: Run | null = null
    const first = adder(bus, { beforeLock: () => {
      second ??= adder(bus)(['[owner] the second, at the same instant.'])
    } })(['[owner] the first.'])
    expect(second).toMatchObject({ code: 0, err: [] })
    expect(first).toMatchObject({ code: 0, err: [] })
    expect(bus.recorded.map(decision => decision.decisionId).sort()).toEqual([2, 3])
    expect(numbersIn(bus.state[FILE])).toEqual([1, 2, 3])
    expect(bus.state[FILE]).toContain('the first.')
    expect(bus.state[FILE]).toContain('the second, at the same instant.')
    expect(refusalsOf(bus.state)).toEqual([])
  })

  it('an add that starts while another holds the lock, after its read or after its write, writes nothing and the holder issues its number alone', () => {
    for (const moment of ['afterRead', 'afterWrite'] as const) {
      const bus = shared({ [FILE]: decisionsFile(ONE) })
      let second: Run | null = null
      const first = adder(bus, { [moment]: () => {
        second ??= adder(bus)(['[owner] the second.'])
      } })(['[owner] the first.'])
      expect(first, moment).toMatchObject({ code: 0, err: [] })
      expect(second, moment).toEqual({ code: 1, out: [], err: [`[decisions] ${FILE}.lock is held by another decisions:add; nothing written, run it again`] })
      expect(bus.recorded.map(decision => decision.decisionId), moment).toEqual([2])
      expect(numbersIn(bus.state[FILE]), moment).toEqual([1, 2])
      expect(bus.locked, moment).toBe(false)
    }
  })

  it('the lock is released when the add is refused or its record fails', () => {
    const bus = shared({ [FILE]: decisionsFile(ONE) })
    expect(adder(bus)(['--supersedes', 'D-9', '[owner] nine.']).code).toBe(1)
    expect(bus.locked).toBe(false)
    expect(adder(bus, { record: () => {
      throw new Error('the bus is down')
    } })(['[owner] two.']).code).toBe(1)
    expect(bus.locked).toBe(false)
    expect(adder(bus)(['[owner] two.']).code).toBe(0)
  })
})

describe('the lock file beside the decisions file', () => {
  it('is taken by one holder at a time, released by its holder, and a refusal names the holder and the way out', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'decisions-lock-'))
    try {
      const lock = lockFileOf(path.join(root, 'owner-decisions.md'))
      const release = takeFileLock(lock)
      expect(typeof release).toBe('function')
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
      expect(takeFileLock(lock, 2, 0)).toBe(`[decisions] ${lock} is held by process ${process.pid}; nothing written. Run decisions:add again; if no decisions:add is running, remove ${lock} first`)
      ;(release as () => void)()
      expect(existsSync(lock)).toBe(false)
      const again = takeFileLock(lock, 1, 0)
      expect(typeof again).toBe('function')
      ;(again as () => void)()

      writeFileSync(lock, '')
      expect(takeFileLock(lock, 1, 0)).toBe(`[decisions] ${lock} is held by another decisions:add; nothing written. Run decisions:add again; if no decisions:add is running, remove ${lock} first`)
      expect(readFileSync(lock, 'utf8')).toBe('')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('decisions:add without an injected lock takes the lock file and leaves none behind', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'decisions-add-lock-'))
    try {
      const file = path.join(root, 'owner-decisions.md')
      writeFileSync(file, decisionsFile(ONE))
      const seen: boolean[] = []
      const code = runDecisionsAdd(['[owner] two.'], {
        decisions: file,
        now: () => NOW,
        exists: existsSync,
        read: candidate => readFileSync(candidate, 'utf8'),
        write: (candidate, text) => {
          seen.push(existsSync(lockFileOf(file)))
          writeFileSync(candidate, text)
        },
        remove: candidate => rmSync(candidate),
        record: () => {},
        settled: () => false,
        out: () => {},
        err: () => {},
      })
      expect(code).toBe(0)
      expect(seen).toEqual([true])
      expect(existsSync(lockFileOf(file))).toBe(false)
      expect(numbersIn(readFileSync(file, 'utf8'))).toEqual([1, 2])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a failed add restores only what it wrote', () => {
  const expired = '- D-2 · 2026-11-01 ~10:00Z — [owner] two. · until 2026-11-02T00:00Z · decisions:add'

  it('a file another writer replaced after this add wrote it is left as the other writer left it', () => {
    const bus = shared({ [FILE]: decisionsFile(ONE, expired), [ARCHIVE]: `${ARCHIVE_HEADER}` })
    const theirs = decisionsFile(ONE, '- D-3 · 2026-11-05 ~11:52Z — [owner] theirs. · decisions:add')
    const theirArchive = `${ARCHIVE_HEADER}${expired}\n- D-9 · 2026-11-05 — theirs.\n`
    const result = adder(bus, { record: () => {
      bus.state[FILE] = theirs
      bus.state[ARCHIVE] = theirArchive
      throw new Error('decision.recorded:3 is already in the bus')
    } })(['[owner] mine.'])
    expect(result.code).toBe(1)
    expect(bus.state).toEqual({ [FILE]: theirs, [ARCHIVE]: theirArchive })
  })

  it('a file still holding what this add wrote is restored, an archive it created is removed and one it extended is put back', () => {
    const before = decisionsFile(ONE, expired)
    const failing = { record: () => {
      throw new Error('the bus is down')
    } }
    const created = shared({ [FILE]: before })
    expect(adder(created, failing)(['[owner] mine.']).code).toBe(1)
    expect(created.state).toEqual({ [FILE]: before })

    const extended = shared({ [FILE]: before, [ARCHIVE]: `${ARCHIVE_HEADER}- D-0 placeholder\n` })
    expect(adder(extended, failing)(['[owner] mine.']).code).toBe(1)
    expect(extended.state).toEqual({ [FILE]: before, [ARCHIVE]: `${ARCHIVE_HEADER}- D-0 placeholder\n` })
  })
})

describe('the rotation moves every record of a number, or none', () => {
  it('a working file with two records of one number, one expired, rotates without breaking the next decisions:add', () => {
    const before = decisionsFile(
      '- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add',
      '- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add',
      '- D-2 · 2026-11-05 ~11:52Z — [owner] two b. · decisions:add',
    )
    const bus = shared({ [FILE]: before })
    const { state } = bus
    const add = adder(bus)

    const plain = add(['[owner] three.'])
    expect(plain.code).toBe(1)
    expect(state).toEqual({ [FILE]: before })
    expect(plain.err.join('\n')).toContain('D-2: on line 6 and line 7; a number names one decision; pnpm decisions:add --supersedes D-2 "[owner] <what D-2 says now>" retires every record of D-2')

    const settled = add(['--supersedes', 'D-2', '[owner] two b, restated.'])
    expect(settled).toMatchObject({ code: 0, err: [] })
    expect(numbersIn(state[ARCHIVE])).toEqual([2, 2])
    expect(numbersIn(state[FILE])).toEqual([1, 3])
    expect(refusalsOf(state)).toEqual([])

    const next = add(['[owner] four.'])
    expect(next).toMatchObject({ code: 0, err: [] })
    expect(numbersIn(state[FILE])).toEqual([1, 3, 4])
    expect(refusalsOf(state)).toEqual([])
  })

  it('two records of one number, both out of force, leave the working file together', () => {
    const state: Record<string, string> = { [FILE]: decisionsFile(
      '- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add',
      '- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add',
      '- D-2 · 2026-11-05 ~11:52Z — [owner] two b. · until 2026-11-05T11:30Z · decisions:add',
    ) }
    const result = adder(shared(state))(['[owner] three.'])
    expect(result).toMatchObject({ code: 0, err: [] })
    expect(state[ARCHIVE]).toBe(`${ARCHIVE_HEADER}- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add\n- D-2 · 2026-11-05 ~11:52Z — [owner] two b. · until 2026-11-05T11:30Z · decisions:add\n`)
    expect(numbersIn(state[FILE])).toEqual([1, 3])
    expect(refusalsOf(state)).toEqual([])
  })

  it('a record that leaves while a sibling of its number stays in force keeps both in the working file', () => {
    const lapsed = '- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add'
    const staying = '- D-2 · 2026-11-05 ~11:52Z — [owner] two b. · decisions:add'
    const plan = planAdd(decisionsFile(ONE, lapsed, staying), '', { file: null, supersedes: [], cards: [], until: null, text: '[owner] three.' }, NOW)
    expect(plan).toMatchObject({ number: 3, archive: '', archived: [] })
    expect((plan as { file: string }).file).toBe(decisionsFile(ONE, lapsed, staying, '- D-3 · 2026-11-05 ~11:52Z — [owner] three. · decisions:add'))
  })
})

describe('a number held by the working file and the archive', () => {
  it('a duplicate number between the working file and the archive is settled by --supersedes and the next decisions:add passes', () => {
    const before = decisionsFile(
      '- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add',
      '- D-2 · 2026-11-05 ~11:52Z — two b.',
    )
    const archive = `${ARCHIVE_HEADER}- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add\n`
    const bus = shared({ [FILE]: before, [ARCHIVE]: archive })
    const { state, recorded } = bus
    const add = adder(bus)

    const plain = add(['[owner] three.'])
    expect(plain.code).toBe(1)
    expect(state).toEqual({ [FILE]: before, [ARCHIVE]: archive })
    expect(plain.err.join('\n')).toContain('D-2: on line 6 and in the archive; a number names one decision; pnpm decisions:add --supersedes D-2')

    const settled = add(['--supersedes', 'D-2', '[owner] two b, restated.'])
    expect(settled).toMatchObject({ code: 0, err: [] })
    expect(recorded.at(-1)).toMatchObject({ decisionId: 3, supersedes: [2] })
    expect(numbersIn(state[FILE])).toEqual([1, 3])
    expect(refusalsOf(state)).toEqual([])

    const next = add(['[owner] four.'])
    expect(next).toMatchObject({ code: 0, err: [] })
    expect(numbersIn(state[FILE])).toEqual([1, 3, 4])
    expect(refusalsOf(state)).toEqual([])
  })

  it('the rebuild from the bus never writes a number into the working file that the archive holds', () => {
    const file = decisionsFile('- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add')
    const archive = `${ARCHIVE_HEADER}- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · decisions:add\n`
    const rows: DecisionRow[] = [
      { number: 1, text: 'one.', cards: [], until: null, inForce: true, written: true, recordedAt: '2026-11-01T10:00:00Z', supersededBy: null },
      { number: 2, text: 'two b.', cards: [], until: null, inForce: true, written: false, recordedAt: '2026-11-05T11:52:00Z', supersededBy: null },
    ]
    const projected = projectDecisions(rows, file, archive, ARCHIVE_HEADER)
    expect(decisionsRefusals(projected.file, projected.archive)).toEqual([])
    expect(projected).toEqual({ file, archive })
  })

  it('the rebuild never writes two lines of one number or an unmarked line after a marked one', () => {
    const file = decisionsFile(ONE)
    const row = (number: number, text: string, written: boolean): DecisionRow => ({ number, text, cards: [], until: null, inForce: true, written, recordedAt: '2026-11-05T11:52:00Z', supersededBy: null })
    const one = row(1, 'one.', true)
    for (const rows of [[one, row(2, 'two a.', true), row(2, 'two b.', true)], [one, row(2, 'two, imported.', false)]]) {
      const projected = projectDecisions(rows, file, '', ARCHIVE_HEADER)
      expect(projected).toEqual({ file, archive: '' })
    }
    const valid = projectDecisions([one, row(2, 'two.', true)], file, '', ARCHIVE_HEADER)
    expect(numbersIn(valid.file)).toEqual([1, 2])
    expect(decisionsRefusals(valid.file, valid.archive)).toEqual([])
  })
})
