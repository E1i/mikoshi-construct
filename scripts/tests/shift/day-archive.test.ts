import { describe, expect, it } from 'vitest'
import { DECISIONS_IN_FORCE_LIMIT } from '../../decisions/decisions.js'
import { appended, archiveOfDay, DAY_FILE_LIMIT, dayFileNamedIn, QUESTIONS_HEADING, splitDay } from '../../shift/day-archive.js'

const OPEN = '- Q21 open — R4 design: which limit?\n  options (a) and (b)'
const ANSWERED = '- Q20 answered — Q17 cleanup blocked\n  options (a), (b), (c)'
const SESSION_ORDER = '## Owner order, session 18 (verbatim)\n\nМико: R4 первым.'
const EARLIER_ORDER = '## Owner order, session 16 (verbatim)\n\nМико: доводи #1015.'
const PROGRESS = '## Progress (window-maintained)\n\n- session 17, #1016 merged.'
const PREAMBLE_TEXT = 'Мико: владелец уезжает на весь день.'

function day(): string {
  return `# Owner's day list, 2026-10-17\n\n${PREAMBLE_TEXT}\n\n${EARLIER_ORDER}\n\n${SESSION_ORDER}\n\n${QUESTIONS_HEADING}\n\n${ANSWERED}\n${OPEN}\n\n${PROGRESS}\n`
}

describe('the day file keeps the open questions and the session owner texts', () => {
  it('keeps the open questions and the session owner texts and moves every other part verbatim to the day archive', () => {
    const { kept, moved } = splitDay(day(), '18')
    expect(kept).toBe(`# Owner's day list, 2026-10-17\n\n${SESSION_ORDER}\n\n${QUESTIONS_HEADING}\n\n${OPEN}\n`)
    for (const part of [PREAMBLE_TEXT, EARLIER_ORDER, ANSWERED, PROGRESS])
      expect(moved).toContain(part)
    for (const part of [SESSION_ORDER, OPEN])
      expect(moved).not.toContain(part)
    expect(moved).toContain(`${QUESTIONS_HEADING}\n\n${ANSWERED}`)
  })

  it('moves nothing from a day file that holds only what it keeps', () => {
    const { kept } = splitDay(day(), '18')
    expect(splitDay(kept, '18')).toEqual({ kept, moved: '' })
  })

  it('reads a session number only as a whole session heading, never sessions 15-17', () => {
    const { kept } = splitDay('# Day\n\n## Owner answers, sessions 15-17\n\ntext\n', '15')
    expect(kept).toBe('# Day\n')
  })

  it('the day file and the decisions share one limit', () => {
    expect(DAY_FILE_LIMIT).toBe(DECISIONS_IN_FORCE_LIMIT)
    expect(DAY_FILE_LIMIT).toBe(8000)
  })

  it('finds the day file a draft names, from the home directory or beside the handoff, and not its archive', () => {
    expect(dayFileNamedIn('day list: ~/.construct/handoff/day-2026-10-17.md — questions', '/home/x', '/h')).toBe('/home/x/.construct/handoff/day-2026-10-17.md')
    expect(dayFileNamedIn('day list: day-2026-10-17.md', '/home/x', '/h')).toBe('/h/day-2026-10-17.md')
    expect(dayFileNamedIn('owner answers: day-2026-10-17.archive.md § Owner order, session 16', '/home/x', '/h')).toBeNull()
  })

  it('appends to the archive beside the day file and keeps what it held', () => {
    expect(archiveOfDay('/h/day-2026-10-17.md')).toBe('/h/day-2026-10-17.archive.md')
    expect(appended('', 'one\n')).toBe('one\n')
    expect(appended('one', 'two\n')).toBe('one\n\ntwo\n')
  })
})
