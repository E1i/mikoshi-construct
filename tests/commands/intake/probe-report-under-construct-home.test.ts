import type { DraftCard, UnclearField } from '../../../src/commands/intake/draft.js'
import type { RepositoryFacts } from '../../../src/commands/intake/facts.js'
import type { SlicedCard } from '../../../src/commands/intake/slice.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDraft, HOME_PATH_REASON, isProbeReport, PROBE_REPORT_HOME } from '../../../src/commands/intake/check.js'
import { runIntake } from '../../../src/commands/intake/index.js'

const REPORT = `${PROBE_REPORT_HOME}/intake-outside/report.md`
const TAKEN = 'taken.txt'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function parked(kind: string, fields: { touches: string[], creates?: string[] }): SlicedCard {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'probe-home-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'a.ts'), '')
  writeFileSync(path.join(dir, TAKEN), '')
  const draft = JSON.stringify({ cards: [{ name: 'outside-report', kind, milestone: 'construct', size: 'S', decision: kind === 'probe' ? 'none' : 'auto', who: 'shift', ...fields, task: 'Measure it.', witnesses: ['`test -f a.ts` passes'] }] })
  const result = runIntake({ draft: '-', taken: path.join(dir, TAKEN), parking: dir, parkingRoot: dir, contourMap: path.join(dir, 'no-contour-map.md'), dir, dryRun: true, autoConfirm: true, readStdin: () => draft })
  if (result.status !== 'dryRun')
    throw new Error(JSON.stringify(result))
  return result.cards[0]!
}

function checkedUnclear(kind: string, created: string): UnclearField[] {
  const repository: RepositoryFacts = { exists: relative => relative === 'a.ts', pathsNamed: () => [], commandResolves: () => true, testsCovering: () => [] }
  const card: DraftCard = { name: 'creates-only', kind, milestone: 'construct', size: 'S', decision: kind === 'probe' ? 'none' : 'auto', who: 'shift', touches: ['a.ts'], depends: [], blocks: [], creates: [created], task: 'Measure it.', witnesses: ['`test -f a.ts` passes'], unclear: [] }
  const [checked] = checkDraft([card], [1], { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository })
  return checked!.unclear.filter(entry => entry.field === 'creates')
}

describe('a probe report under the construct home', () => {
  it('a probe card naming its report under the construct home parks with no unclear field', () => {
    for (const fields of [{ touches: [REPORT] }, { touches: [REPORT], creates: [REPORT] }, { touches: ['a.ts', REPORT] }]) {
      const card = parked('probe', fields)
      expect(card.unclear).toEqual([])
      expect(card.who).toBe('shift')
      expect(card.text).toContain(`touches: ${fields.touches.join(', ')}\n`)
    }
  })

  it('an implement card naming a home path is still refused', () => {
    const card = parked('implement', { touches: [REPORT] })
    expect(card.unclear.map(entry => entry.field)).toContain('touches')
    expect(card.who).toBe('window')
  })

  it('an implement card that lists the home path under creates is held with the home reason', () => {
    const card = parked('implement', { touches: [REPORT], creates: [REPORT] })
    expect(card.unclear).toEqual([{ field: 'touches', reason: `'${REPORT}': ${HOME_PATH_REASON}` }])
    expect(card.who).toBe('window')
  })

  it('a probe card naming a home path outside the probes root is held', () => {
    const card = parked('probe', { touches: ['~/.construct/bus/bus.db'] })
    expect(card.unclear).toEqual([{ field: 'touches', reason: `'~/.construct/bus/bus.db': ${HOME_PATH_REASON}` }])
    expect(card.who).toBe('window')
  })

  it('a probe naming its home report only under creates', () => {
    expect(checkedUnclear('probe', REPORT)).toEqual([])
    expect(checkedUnclear('probe', '~/.construct/bus/bus.db')).toEqual([{ field: 'creates', reason: `'~/.construct/bus/bus.db': ${HOME_PATH_REASON}` }])
    expect(checkedUnclear('implement', REPORT)).toEqual([{ field: 'creates', reason: `'${REPORT}': ${HOME_PATH_REASON}` }])
  })

  it('a dot or empty segment under the probes home is not a probe report', () => {
    for (const entry of [`${PROBE_REPORT_HOME}/./x`, `${PROBE_REPORT_HOME}//x`, `${PROBE_REPORT_HOME}/intake/./report.md`, `${PROBE_REPORT_HOME}/intake//report.md`])
      expect(isProbeReport(entry)).toBe(false)
  })

  it.each([
    [REPORT, true],
    [`${PROBE_REPORT_HOME}/intake-outside/**`, true],
    [PROBE_REPORT_HOME, false],
    [`${PROBE_REPORT_HOME}/../bus/bus.db`, false],
    ['~/.construct/probes-elsewhere/report.md', false],
  ])('reads %s as a probe report: %s', (entry, report) => {
    expect(isProbeReport(entry)).toBe(report)
  })
})
