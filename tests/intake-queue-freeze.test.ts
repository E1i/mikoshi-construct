import type { AdmitResult } from '../src/commands/intake/admit.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { printAdmit, runAdmit } from '../src/commands/intake/admit.js'
import { INTAKE_EXIT } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-09T09:00:00.000Z')
const OWNER_AXES = ['autonomy', 'cost', 'self-learning', 'interface', 'architecture']
const SKILLS = ['.claude/skills/intake/SKILL.md', 'templates/ai/claude/_claude/skills/intake/SKILL.md']
const LAW = 'Решение: Law. Owner, 2026-10-09: the rule.'
const QUEUED = '#700 queued-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const AXIS_CARD = '#600 axis-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const NEW = '#801 new-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const BLOCKS_QUEUED = '#801 new-card [implement/runner/S/cheap/owner] · depends — · blocks #700'
const BLOCKS_AXIS_CARD = '#801 new-card [implement/runner/S/cheap/owner] · depends — · blocks #600'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, journal: string, repo: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-queue-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  const w = { parking: path.join(root, 'parking'), journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo }
  park(w, 'lane-1', QUEUED)
  park(w, 'cost', AXIS_CARD)
  return w
}

function park(w: World, dir: string, card: string, body = 'Do the thing.'): string {
  const id = /^#(\d+)/.exec(card)![1]
  mkdirSync(path.join(w.parking, dir), { recursive: true })
  const file = path.join(w.parking, dir, `${id}.md`)
  writeFileSync(file, `card: ${card}\nbranch: feat/card-${id}\ntouches: src/board/**\ncontinue: stop\nwho: shift\n\n${body}\n`)
  return file
}

function admit(w: World, file: string, dryRun = false): AdmitResult {
  return runAdmit({ file, dir: w.repo, journal: w.journal, dryRun, autoConfirm: false, parkingRoot: w.parking }, () => NOW)
}

function printed(result: AdmitResult): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printAdmit(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

describe('construct intake --admit keeps the queue frozen', () => {
  it('admit into a lane refuses a card without the Law line that blocks no queue card, naming the five axes', () => {
    for (const [lane, card, body, dryRun] of [
      ['lane-2', NEW, 'Do the thing.', false],
      ['2026-10-09-a', NEW, 'Do the thing.', false],
      ['lane-1', NEW, 'Do the thing.', true],
      ['lane-2', BLOCKS_AXIS_CARD, 'Do the thing.', false],
      ['lane-2', NEW, 'Решение: Lawful, says nobody.', false],
      ['lane-2', NEW, 'The line Решение: Law is quoted, not carried.', false],
    ] as const) {
      const w = world()
      const file = park(w, lane, card, body)
      const before = readFileSync(file, 'utf8')
      const result = admit(w, file, dryRun)
      expect(result).toEqual({ status: 'queueFrozen', lane })
      const { lines, exit } = printed(result)
      expect(exit).toBe(INTAKE_EXIT.refused)
      for (const axis of OWNER_AXES)
        expect(lines.join('\n')).toContain(axis)
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(existsSync(w.journal)).toBe(false)
    }
  })

  it('admit into a lane takes a card with the Law line', () => {
    for (const lane of ['lane-2', '2026-10-09-a']) {
      const w = world()
      expect(admit(w, park(w, lane, NEW)).status).toBe('queueFrozen')
      const result = admit(w, park(w, lane, NEW, `Context first.\n\n${LAW}`))
      expect(result.status).toBe('admitted')
      expect(readFileSync(w.journal, 'utf8')).toContain('"task":"801"')
    }
  })

  it('admit into a lane takes a card that blocks a queue card', () => {
    const w = world()
    expect(admit(w, park(w, 'lane-2', BLOCKS_AXIS_CARD)).status).toBe('queueFrozen')
    const result = admit(w, park(w, 'lane-2', BLOCKS_QUEUED))
    expect(result.status).toBe('admitted')
  })

  it('admit outside a lane is not held by the queue', () => {
    for (const dir of ['autonomy', 'night-1', 'lane-x', '.']) {
      const w = world()
      expect(admit(w, park(w, dir, NEW)).status).toBe('admitted')
    }
    const w = world()
    const nested = park(w, path.join('cost', 'lane-3'), NEW)
    expect(admit(w, nested).status).toBe('admitted')
  })

  it('a card already admitted is amended in its lane, not refused as new', () => {
    const w = world()
    const file = park(w, 'lane-2', NEW)
    mkdirSync(path.dirname(w.journal), { recursive: true })
    writeFileSync(w.journal, `${JSON.stringify({ event: 'intake', task: '801', card: NEW, bodySha: 'an older body' })}\n`)
    const result = admit(w, file)
    expect(result.status).toBe('admitted')
    expect(result.status === 'admitted' && result.source).toBe('amend')
  })

  it('the intake skill states the queue rule with the five axes', () => {
    for (const skill of SKILLS) {
      const text = readFileSync(skill, 'utf8')
      expect(text).toContain('`Решение: Law`')
      for (const axis of OWNER_AXES)
        expect(text).toContain(`\`${axis}\``)
    }
  })
})
