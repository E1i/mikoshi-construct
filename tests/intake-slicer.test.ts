import type { Buffer } from 'node:buffer'
import type { ShiftDeps } from '../scripts/shift/shift.js'
import type { IntakeOptions, IntakeResult } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runShift } from '../scripts/shift/shift.js'
import { parseParkingFile, WINDOW_WHO } from '../src/card/parking.js'
import { INTAKE_EXIT, printIntake, readStdinToEnd, runIntake } from '../src/commands/intake/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const RETELLING = [
  'The board should show which cards wait in the parking, so the owner sees the queue without opening the folder.',
  'Then the shift should skip a card whose touches overlap an open pull request, and say which one.',
  'Last, a probe: read how the release workflow decides the version, and report what it reads.',
]

const SLICED = {
  cards: [
    { name: 'board-parking', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches: ['scripts/board/**', 'tests/board/**'], task: RETELLING[0], witnesses: ['a parked card appears on the board with its who'] },
    { name: 'shift-skips-open-pr', kind: 'implement', milestone: 'runner', size: 'M', contour: 'cheap', decision: 'owner', who: 'shift', touches: ['scripts/shift/**'], depends: ['board-parking'], task: RETELLING[1], witnesses: ['a card overlapping an open pull request is left with that pull request named'] },
    { name: 'release-version-probe', kind: 'probe', milestone: 'infra', size: 'S', contour: 'cheap', who: 'window', touches: ['.github/workflows/**'], task: RETELLING[2], witnesses: ['the report names the file and line the version is read from'] },
  ],
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-'))
  roots.push(root)
  return root
}

function intake(draft: unknown, taken: string, parking: string, options: Partial<IntakeOptions> = {}): IntakeResult {
  const root = path.dirname(parking)
  const draftFile = path.join(root, 'draft.json')
  writeFileSync(draftFile, typeof draft === 'string' ? draft : JSON.stringify(draft))
  return runIntake({ draft: draftFile, taken: '-', parking, journal: path.join(root, 'ghosts.jsonl'), dryRun: false, autoConfirm: false, readStdin: () => taken, ...options })
}

function cards(result: IntakeResult) {
  if (result.status === 'refused')
    throw new Error(`refused: ${result.refusal} ${result.detail.join('; ')}`)
  return result.cards
}

function detail(result: IntakeResult): string[] {
  return result.status === 'refused' ? result.detail : []
}

function shiftDeps(root: string, out: string[], err: string[]): ShiftDeps {
  const unused = (): never => {
    throw new Error('a --check run starts nothing')
  }
  return {
    cwd: root,
    claude: undefined,
    header: '',
    handoffDir: path.join(root, 'handoff'),
    readJournal: unused,
    projectsDir: path.join(root, 'projects'),
    git: unused,
    install: unused,
    gh: () => {
      throw new Error('gh is not read in this test')
    },
    listDir: dir => readdirSync(dir),
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: unused,
    now: () => new Date('2026-10-04T00:00:00.000Z'),
    uuid: () => 'uuid',
    run: unused,
    out: line => out.push(line),
    err: line => err.push(line),
  }
}

describe('intake slices a three-paragraph retelling into parking cards', () => {
  it('writes one valid card per paragraph under the next numbers free in the parking and among --taken', async () => {
    const root = scratch()
    const parking = path.join(root, 'parking')
    mkdirSync(parking)
    writeFileSync(path.join(parking, '540.md'), 'an earlier card')
    const written = cards(intake(SLICED, '530\n#523 541', parking))
    expect(written.map(card => card.file)).toEqual(['542.md', '543.md', '544.md'])
    for (const [index, card] of written.entries()) {
      const text = readFileSync(path.join(parking, card.file), 'utf8')
      expect(text).toBe(card.text)
      expect(text).toContain(RETELLING[index])
      expect(parseParkingFile(card.file, text).kind).toBe('parked')
    }
    expect(written[0]!.line).toBe('#542 board-parking [implement/runner/S/cheap/auto] · depends — · blocks #543')
    expect(written[1]!.line).toBe('#543 shift-skips-open-pr [implement/runner/M/cheap/owner] · depends #542 · blocks —')
    expect(written[2]!.line).toBe('#544 release-version-probe [probe/infra/S/cheap/none] · depends — · blocks —')
  })

  it('leaves a parking that pnpm shift --check passes', async () => {
    const root = scratch()
    const parking = path.join(root, 'parking')
    cards(intake(SLICED, '530', parking))
    rmSync(path.join(root, 'draft.json'))
    const out: string[] = []
    const err: string[] = []
    const exit = await runShift([path.join(root, 'shift'), '--parking', parking, '--check'], shiftDeps(root, out, err))
    expect(err.filter(line => !line.includes('open pull requests not read'))).toEqual([])
    expect(exit).toBe(0)
    expect(out).toContain('[shift] check passed: 531.md')
  })

  it('prints the cards and writes nothing on a dry run', () => {
    const root = scratch()
    const parking = path.join(root, 'parking')
    const result = intake(SLICED, '1', parking, { dryRun: true })
    expect(result.status).toBe('dryRun')
    expect(existsSync(parking)).toBe(false)
  })
})

describe('intake marks what the retelling left unclear and guesses nothing silently', () => {
  const vague = { name: 'vague-card', kind: 'implement', milestone: 'black-ice', size: 'M', who: 'shift', touches: ['src/model/**'], task: 'Make the queue visible somehow.', witnesses: ['a test'], unclear: [{ field: 'milestone', reason: 'attach repository: no milestone of its own, black-ice taken from the closed list' }] }

  it('writes an unclear line per field, defaults only contour and decision, and keeps the card with the window', () => {
    const root = scratch()
    const [card] = cards(intake({ cards: [vague] }, '7', path.join(root, 'parking')))
    expect(card!.line).toBe('#8 vague-card [implement/black-ice/M/ladder/owner] · depends — · blocks —')
    expect(card!.who).toBe(WINDOW_WHO)
    expect(card!.text).toContain('who: window\n')
    expect(card!.text.split('\n').filter(line => line.startsWith('unclear: '))).toEqual([
      'unclear: milestone — attach repository: no milestone of its own, black-ice taken from the closed list',
      'unclear: contour — not stated in the retelling; set to ladder, the path with a brief and witnesses',
      'unclear: decision — not stated in the retelling; set to owner, so the owner merges',
    ])
    expect(parseParkingFile(card!.file, card!.text)).toMatchObject({ kind: 'parked', parked: { who: WINDOW_WHO } })
  })

  it('refuses a card whose touches, milestone or witnesses are missing, naming each, and writes nothing', () => {
    const root = scratch()
    const parking = path.join(root, 'parking')
    const { touches: _t, milestone: _m, witnesses: _w, ...missing } = vague
    const result = intake({ cards: [missing] }, '7', parking)
    expect(result).toMatchObject({ status: 'refused', refusal: 'invalid' })
    expect(detail(result)).toEqual([
      'card 1: \'milestone\' is missing; it has no default, so the retelling has to state it',
      'card 1: \'touches\' is missing; it has no default, so the retelling has to state at least one',
      'card 1: \'witnesses\' is missing; it has no default, so the retelling has to state at least one',
    ])
    expect(existsSync(parking)).toBe(false)
  })
})

describe('intake refuses what it cannot number or check', () => {
  it('refuses without --taken, since a card number is shared with pull requests and issues', () => {
    const root = scratch()
    expect(intake(SLICED, '', path.join(root, 'parking'), { taken: undefined })).toEqual({ status: 'refused', refusal: 'noTaken', detail: [] })
  })

  it('refuses a draft and --taken that both read stdin', () => {
    const root = scratch()
    expect(intake(SLICED, '', path.join(root, 'parking'), { draft: '-' }).status).toBe('refused')
  })

  it('refuses --taken text that is not numbers', () => {
    const root = scratch()
    expect(detail(intake(SLICED, '12 PR-13', path.join(root, 'parking')))).toEqual(['\'PR-13\' is not a pull request or issue number; --taken holds numbers separated by whitespace'])
  })

  it('refuses a value outside the card grammar with the grammar\'s own reason', () => {
    const root = scratch()
    const draft = { cards: [{ ...SLICED.cards[0], kind: 'fix' }] }
    expect(detail(intake(draft, '1', path.join(root, 'parking')))).toEqual(['board-parking: 2.md: card refused: kind \'fix\' is not one of implement, probe; a parked card also takes who, priority'])
  })

  it('refuses a depends entry that names no card of the draft and is not #<id>', () => {
    const root = scratch()
    const draft = { cards: [{ ...SLICED.cards[0], depends: ['somewhere-else'] }] }
    expect(detail(intake(draft, '1', path.join(root, 'parking')))).toEqual(['board-parking: \'somewhere-else\' names no card of this draft and is not \'#<id>\''])
  })

  it('refuses an unknown key rather than dropping it', () => {
    const root = scratch()
    const draft = { cards: [{ ...SLICED.cards[0], priority: 600 }] }
    expect(detail(intake(draft, '1', path.join(root, 'parking')))).toEqual(['card 1: unknown key \'priority\'; the keys are name, kind, milestone, size, task, contour, decision, branch, who, continue, touches, witnesses, depends, blocks, creates, number, unclear'])
  })

  it('refuses a name given to two cards, since depends name cards by it', () => {
    const root = scratch()
    const draft = { cards: [SLICED.cards[0], SLICED.cards[0]] }
    expect(detail(intake(draft, '1', path.join(root, 'parking')))).toEqual(['the name \'board-parking\' is given to more than one card'])
  })
})

describe('printIntake', () => {
  it('names each card written and its unclear count, and exits by the result', () => {
    const lines: string[] = []
    const ui = createUi(resolveTheme({ plain: true }), line => lines.push(line))
    const root = scratch()
    const result = intake({ cards: [{ ...SLICED.cards[0], contour: undefined }] }, '1', path.join(root, 'parking'))
    expect(printIntake(ui, result)).toBe(INTAKE_EXIT.written)
    expect(lines.join('\n')).toContain('#2 board-parking [implement/runner/S/ladder/auto]')
    expect(lines.join('\n')).toContain('1 unclear field marked in the card; it stays with who: window until a person settles them.')
    expect(printIntake(createUi(resolveTheme({ plain: true }), silentWriter), { status: 'refused', refusal: 'noDraft', detail: [] })).toBe(INTAKE_EXIT.refused)
  })
})

function scriptedSource(steps: Array<string | NodeJS.ErrnoException>): (buffer: Buffer) => number {
  return (buffer) => {
    const step = steps.shift()
    if (step === undefined)
      return 0
    if (typeof step !== 'string')
      throw step
    return buffer.write(step)
  }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('readStdinToEnd', () => {
  it('waits out an EAGAIN from a producer slower than startup and returns what it then writes', () => {
    expect(readStdinToEnd(scriptedSource([errno('EAGAIN'), '1 2']))).toBe('1 2')
  })

  it('joins every chunk up to the end of the stream', () => {
    expect(readStdinToEnd(scriptedSource(['1 ', errno('EAGAIN'), '2 ', '3']))).toBe('1 2 3')
  })

  it('throws any other read error instead of retrying it', () => {
    expect(() => readStdinToEnd(scriptedSource([errno('EBADF')]))).toThrow('EBADF')
  })
})
