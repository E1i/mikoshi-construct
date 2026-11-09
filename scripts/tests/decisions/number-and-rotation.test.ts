import type { OwnerDecision } from '../../policy/decisions.js'
import type { DecisionRow } from '../../policy/decisions/decisions.js'
import { describe, expect, it } from 'vitest'
import { ARCHIVE_HEADER, runDecisionsAdd } from '../../policy/decisions/add.js'
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

function adder(state: Record<string, string>, recorded: OwnerDecision[], beforeFirstRead: () => void = () => {}): (args: string[]) => Run {
  return (args) => {
    const out: string[] = []
    const err: string[] = []
    let firstRead = true
    const code = runDecisionsAdd(['--file', FILE, ...args], {
      decisions: FILE,
      now: () => NOW,
      exists: file => file in state,
      read: (file) => {
        const text = state[file]!
        if (file === FILE && firstRead) {
          firstRead = false
          beforeFirstRead()
        }
        return text
      },
      write: (file, text) => {
        state[file] = text
      },
      remove: (file) => {
        delete state[file]
      },
      record: (decision) => {
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

describe('a decision number is issued once', () => {
  it('two concurrent decisions:add get different numbers', () => {
    const state: Record<string, string> = { [FILE]: decisionsFile('- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add') }
    const recorded: OwnerDecision[] = []
    let second: Run | null = null
    const first = adder(state, recorded, () => {
      second = adder(state, recorded)(['[owner] the second, at the same instant.'])
    })(['[owner] the first.'])
    expect(second).toMatchObject({ code: 0, err: [] })
    expect(first).toMatchObject({ code: 0, err: [] })
    expect(recorded.map(decision => decision.decisionId).sort()).toEqual([2, 3])
    expect(numbersIn(state[FILE])).toEqual([1, 2, 3])
    expect(state[FILE]).toContain('the first.')
    expect(state[FILE]).toContain('the second, at the same instant.')
    expect(refusalsOf(state)).toEqual([])
  })
})

describe('the rotation moves every record of a number, or none', () => {
  it('a working file with two records of one number, one expired, rotates without breaking the next decisions:add', () => {
    const before = decisionsFile(
      '- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add',
      '- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add',
      '- D-2 · 2026-11-05 ~11:52Z — [owner] two b. · decisions:add',
    )
    const state: Record<string, string> = { [FILE]: before }
    const recorded: OwnerDecision[] = []
    const add = adder(state, recorded)

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
    const result = adder(state, [])(['[owner] three.'])
    expect(result).toMatchObject({ code: 0, err: [] })
    expect(state[ARCHIVE]).toBe(`${ARCHIVE_HEADER}- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add\n- D-2 · 2026-11-05 ~11:52Z — [owner] two b. · until 2026-11-05T11:30Z · decisions:add\n`)
    expect(numbersIn(state[FILE])).toEqual([1, 3])
    expect(refusalsOf(state)).toEqual([])
  })
})

describe('a number held by the working file and the archive', () => {
  it('a duplicate number between the working file and the archive is settled by --supersedes and the next decisions:add passes', () => {
    const before = decisionsFile(
      '- D-1 · 2026-11-01 ~10:00Z — [owner] one. · decisions:add',
      '- D-2 · 2026-11-05 ~11:52Z — two b.',
    )
    const archive = `${ARCHIVE_HEADER}- D-2 · 2026-11-05 ~11:51Z — [owner] two a. · until 2026-11-05T11:00Z · decisions:add\n`
    const state: Record<string, string> = { [FILE]: before, [ARCHIVE]: archive }
    const recorded: OwnerDecision[] = []
    const add = adder(state, recorded)

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
})
