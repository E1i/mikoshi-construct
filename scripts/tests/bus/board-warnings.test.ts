import type { BusFacts } from '../../../src/commands/board/bus.js'
import type { BoardPage } from '../../cli/board-page.js'
import type { WarningReadings } from '../../cli/board-warnings.js'
import type { GhResponse, GitHub } from '../../ports/github.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { readEddiesLimits, renderBoard } from '../../cli/board-page.js'
import { boardWarnings, LAUNCH_GATE_SLOTS, MAIN_PROTECTION_ENDPOINT, MAIN_RULES_ENDPOINT, MainUpToDate, openPrCountOf, openPrLimitOf, SAVING_OFF_WARNING, savingOff, stallLines, UP_TO_DATE_READ_MS } from '../../cli/board-warnings.js'
import { upToDateRequired } from '../../cli/check-catalog.js'
import { BUS_PULSE } from '../../core/events.js'
import { Meter } from '../../ports/meter.js'
import { slotsOf, slotsVariable } from '../../supervisor/scheduler.js'
import { STALL_MS } from '../../window/watch.js'

const BY_LAYERS = { BUS_RERUN: 'by-layers' }
const NOTHING_TO_WARN: WarningReadings = {
  contexts: [],
  contextLimit: 250_000,
  warnRatio: 0.8,
  openPrs: 0,
  openPrLimit: 5,
  ownerWaits: 0,
  stalls: [],
  savingOff: false,
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function answer(status: number, body: unknown): GhResponse {
  return { status, headers: {}, body }
}

function gitHubOf(protection: GhResponse, rules: GhResponse, asked: string[] = []): GitHub {
  return (endpoint) => {
    asked.push(endpoint)
    return endpoint === MAIN_PROTECTION_ENDPOINT ? protection : rules
  }
}

function mainOf(protection: GhResponse, rules: GhResponse, asked: string[] = []): MainUpToDate {
  return new MainUpToDate(gitHubOf(protection, rules, asked), () => 0)
}

const STRICT_PROTECTION = answer(200, { required_status_checks: { strict: true, contexts: ['required'] } })
const LOOSE_PROTECTION = answer(200, { required_status_checks: { strict: false, contexts: ['required'] } })
const NO_PROTECTION = answer(404, { message: 'Branch not protected' })
const NO_RULES = answer(200, [])
const STRICT_RULES = answer(200, [{ type: 'deletion' }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [] } }])
const LOOSE_RULES = answer(200, [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [] } }])
const NO_ANSWER = answer(599, { message: 'gh api: no answer' })

describe('boardWarnings', () => {
  it('a session at 285k of 250k and 6 open PRs give two warnings', () => {
    const warnings = boardWarnings({ ...NOTHING_TO_WARN, contexts: [{ who: '#861', context: 285_000 }], openPrs: 6 })
    expect(warnings).toEqual([
      { level: 'red', text: '#861: ctx 285k of 250k, over the limit' },
      { level: 'amber', text: `6 open PRs, over the limit of 5 from ${slotsVariable(LAUNCH_GATE_SLOTS)}` },
    ])
  })

  it('a fixture with no violation gives no warning', () => {
    expect(boardWarnings({ ...NOTHING_TO_WARN, contexts: [{ who: '#861', context: 199_999 }], openPrs: 5 })).toEqual([])
  })

  it('the amber line is the limit times the warn ratio of the Eddies file, and red starts above the limit', () => {
    const { contextLimit, warnRatio } = readEddiesLimits()
    const line = contextLimit! * warnRatio!
    const levels = (context: number): string[] => boardWarnings({ ...NOTHING_TO_WARN, contextLimit, warnRatio, contexts: [{ who: 'window', context }] }).map(warning => warning.level)
    expect(levels(line - 1)).toEqual([])
    expect(levels(line)).toEqual(['amber'])
    expect(levels(contextLimit!)).toEqual(['amber'])
    expect(levels(contextLimit! + 1)).toEqual(['red'])
  })

  it('a warn ratio above one is no line, as Eddies reads it, and the limit still turns red', () => {
    const levels = (context: number): string[] => boardWarnings({ ...NOTHING_TO_WARN, warnRatio: 1.5, contexts: [{ who: 'window', context }] }).map(warning => warning.level)
    expect(levels(249_000)).toEqual([])
    expect(levels(251_000)).toEqual(['red'])
  })

  it('an unread limit gives no open PR warning', () => {
    expect(boardWarnings({ ...NOTHING_TO_WARN, openPrs: 40, openPrLimit: null })).toEqual([])
  })

  it('owner waits and stalls each warn', () => {
    expect(boardWarnings({ ...NOTHING_TO_WARN, ownerWaits: 1 }).map(warning => warning.text)).toEqual(['1 open owner wait'])
    expect(boardWarnings({ ...NOTHING_TO_WARN, ownerWaits: 2 }).map(warning => warning.text)).toEqual(['2 open owner waits'])
    expect(boardWarnings({ ...NOTHING_TO_WARN, stalls: ['stall card 7'] }).map(warning => warning.text)).toEqual(['stall card 7'])
  })
})

describe('the sources the warnings read', () => {
  it('the open PR limit is the slot the launch gate reads', () => {
    const gate = readFileSync(path.resolve(import.meta.dirname, '../../ports/task-start.ts'), 'utf8')
    expect(gate).toContain(`const WINDOW_LIMIT_SLOTS = '${LAUNCH_GATE_SLOTS}'`)
    expect(openPrLimitOf({})).toBe(slotsOf(LAUNCH_GATE_SLOTS, {}))
    expect(openPrLimitOf({ [slotsVariable(LAUNCH_GATE_SLOTS)]: '5' })).toBe(5)
    expect(openPrLimitOf({ [slotsVariable(LAUNCH_GATE_SLOTS)]: 'five' })).toBeNull()
  })

  it('a bus whose open PRs cannot be read counts none and does not throw', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-warnings-'))
    roots.push(root)
    const db = new DatabaseSync(writeBus(path.join(root, 'bus.db'), { cards: [] }))
    try {
      expect(openPrCountOf(db)).toBe(0)
    }
    finally {
      db.close()
    }
  })

  it('a card past the stall threshold of the watch warns while the bus pulses, and only then', () => {
    const now = new Date('2026-11-04T12:00:00.000Z')
    const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString()
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-warnings-'))
    roots.push(root)
    const file = writeBus(path.join(root, 'bus.db'), {
      cards: [
        { id: 7, state: 'running', lane: 'lane-1', line: null, since: ago(STALL_MS + 120_000) },
        { id: 8, state: 'running', lane: 'lane-2', line: null, since: ago(STALL_MS - 60_000) },
      ],
      events: [
        { ts: ago(STALL_MS + 60_000), type: 'card.started', card: 7, payload: '{}' },
        { ts: ago(STALL_MS - 60_000), type: 'card.started', card: 8, payload: '{}' },
        { ts: ago(30_000), type: BUS_PULSE, card: null, payload: '{}' },
      ],
    })
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const lines = stallLines(db, ago(30_000), now)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('stall card 7: no new event for 21 minutes')
      expect(stallLines(db, ago(STALL_MS), now)).toEqual([])
      expect(stallLines(db, null, now)).toEqual([])
    }
    finally {
      db.close()
    }
  })
})

describe('the saving warning', () => {
  it('by-layers with an up-to-date requirement on main warns that the saving is off', () => {
    const warned = (protection: GhResponse, rules: GhResponse): string[] => boardWarnings({ ...NOTHING_TO_WARN, savingOff: savingOff(BY_LAYERS, mainOf(protection, rules)) }).map(warning => warning.text)
    expect(warned(STRICT_PROTECTION, NO_RULES)).toEqual([SAVING_OFF_WARNING])
    expect(warned(LOOSE_PROTECTION, STRICT_RULES)).toEqual([SAVING_OFF_WARNING])
    expect(warned(NO_PROTECTION, STRICT_RULES)).toEqual([SAVING_OFF_WARNING])
    expect(warned(LOOSE_PROTECTION, LOOSE_RULES)).toEqual([])
    expect(warned(LOOSE_PROTECTION, NO_RULES)).toEqual([])
    expect(SAVING_OFF_WARNING).toBe('BUS_RERUN=by-layers, но на main strict: true (или ruleset требует up-to-date) — экономия выключена')
  })

  it('a read that fails shows no such warning and does not throw', () => {
    expect(savingOff(BY_LAYERS, mainOf(NO_ANSWER, NO_ANSWER))).toBe(false)
    expect(savingOff(BY_LAYERS, mainOf(LOOSE_PROTECTION, NO_ANSWER))).toBe(false)
    expect(savingOff(BY_LAYERS, mainOf(NO_ANSWER, LOOSE_RULES))).toBe(false)
    expect(savingOff(BY_LAYERS, mainOf(answer(429, {}), answer(403, {})))).toBe(false)
    expect(savingOff(BY_LAYERS, mainOf(answer(200, null), answer(200, 'not a list')))).toBe(false)
    const thrower = new MainUpToDate(() => {
      throw new Error('gh is not installed')
    }, () => 0)
    expect(savingOff(BY_LAYERS, thrower)).toBe(false)
  })

  it('a failed protection read does not hide what the ruleset requires, and the other way round', () => {
    expect(savingOff(BY_LAYERS, mainOf(NO_ANSWER, STRICT_RULES))).toBe(true)
    expect(savingOff(BY_LAYERS, mainOf(STRICT_PROTECTION, NO_ANSWER))).toBe(true)
  })

  it('another rerun mode asks GitHub nothing and warns of nothing', () => {
    const asked: string[] = []
    const main = mainOf(STRICT_PROTECTION, STRICT_RULES, asked)
    expect(savingOff({}, main)).toBe(false)
    expect(savingOff({ BUS_RERUN: 'as-now' }, main)).toBe(false)
    expect(savingOff({ BUS_RERUN: 'sideways' }, main)).toBe(false)
    expect(asked).toEqual([])
  })

  it('the protection read asks the endpoint upToDateRequired asks', () => {
    const asked: string[] = []
    upToDateRequired(new Meter(gitHubOf(STRICT_PROTECTION, NO_RULES, asked), () => 0))
    expect(asked).toEqual([MAIN_PROTECTION_ENDPOINT])
    expect(MAIN_RULES_ENDPOINT).toBe('repos/{owner}/{repo}/rules/branches/main')
  })

  it('a board tick does not ask GitHub again until the read is old', () => {
    const asked: string[] = []
    let now = 1_000
    const main = new MainUpToDate(gitHubOf(LOOSE_PROTECTION, NO_RULES, asked), () => now)
    expect(main.required()).toBe(false)
    expect(asked).toEqual([MAIN_PROTECTION_ENDPOINT, MAIN_RULES_ENDPOINT])
    now += UP_TO_DATE_READ_MS - 1
    expect(main.required()).toBe(false)
    expect(asked).toHaveLength(2)
    now += 1
    expect(main.required()).toBe(false)
    expect(asked).toHaveLength(4)
  })
})

function factsAt(at: string): BusFacts {
  return { at, goal: null, waits: [], pulse: null, slots: [], cards: [], services: [], matrices: [], failure: null, reviewQueue: 0 }
}

function pageWritten(at: string, tickMs: number | null, warnings: BoardPage['warnings'] = []): BoardPage {
  return {
    version: '0.0.0',
    machine: { load: 0, cores: 1 },
    liveness: 'live',
    modelVersion: null,
    facts: factsAt(at),
    windowGauges: null,
    limits: { contextLimit: null, cardContextLine: null, sessionSpend: null, agentSpend: null, warnRatio: null, modelWindows: new Map() },
    details: new Map(),
    decisions: { stale: null, rows: [], at: 0 },
    handoff: { file: 'miko.md', text: null },
    repository: null,
    tickMs,
    warnings,
  }
}

interface FakeLive {
  textContent: string
  stale: boolean
  setAttribute: (name: string) => void
}

function openedAt(html: string, nowMs: number): { live: FakeLive, tick: (board: unknown) => void } {
  const live: FakeLive = {
    textContent: /id="bus-live"[^>]*>([^<]*)</.exec(html)![1]!,
    stale: false,
    setAttribute(name) {
      this.stale = this.stale || name === 'data-stale'
    },
  }
  const body = /<body data-written="([^"]*)" data-tick-ms="([^"]*)">/.exec(html)!
  const scheduled: (() => void)[] = []
  const appended: { onload: () => void, remove: () => void, src: string }[] = []
  const quiet = { addEventListener: () => {}, setAttribute: () => {}, open: false, close: () => {} }
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => id === 'bus-live' ? live : id === 'drill' || id === 'drill-content' ? quiet : null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ remove: () => {}, onload: () => {}, src: '' }),
      head: { appendChild: (script: { onload: () => void, remove: () => void, src: string }) => appended.push(script) },
      body: { dataset: { written: body[1]!, tickMs: body[2]! } },
      title: '',
    },
    location: { hash: '' },
    addEventListener: () => {},
    setTimeout: (run: () => void) => scheduled.push(run),
    Date: { now: () => nowMs, parse: Date.parse },
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, context)
  return {
    live,
    tick: (board) => {
      scheduled.shift()!()
      context.BOARD = board
      appended.at(-1)!.onload()
    },
  }
}

describe('the age of a board', () => {
  const WRITTEN = '2026-11-04T12:00:00.000Z'
  const TICK = 60_000
  const WRITTEN_MS = Date.parse(WRITTEN)

  it('a board written longer ago than twice its refresh shows STALE', () => {
    const html = renderBoard(pageWritten(WRITTEN, TICK))
    expect(html).toContain('<span class="live" id="bus-live">bus live</span>')
    const { live } = openedAt(html, WRITTEN_MS + 2 * TICK + 1)
    expect(live.textContent).toBe('STALE')
    expect(live.textContent).not.toBe('bus live')
    expect(live.stale).toBe(true)
  })

  it('a board at exactly twice its refresh is still live', () => {
    const { live } = openedAt(renderBoard(pageWritten(WRITTEN, TICK)), WRITTEN_MS + 2 * TICK)
    expect(live.textContent).toBe('bus live')
    expect(live.stale).toBe(false)
  })

  it('a board data file that stops changing turns an open page STALE', () => {
    const html = renderBoard(pageWritten(WRITTEN, TICK))
    const { live, tick } = openedAt(html, WRITTEN_MS + 3 * TICK)
    live.textContent = 'bus live'
    live.stale = false
    tick({ written: WRITTEN, tickMs: TICK, slots: {}, filters: [] })
    expect(live.textContent).toBe('STALE')
  })

  it('a board with no refresh has no age to be stale by', () => {
    const { live } = openedAt(renderBoard(pageWritten(WRITTEN, null)), WRITTEN_MS + 100 * TICK)
    expect(live.textContent).toBe('bus live')
  })
})

describe('the warnings strip', () => {
  const WRITTEN = '2026-11-04T12:00:00.000Z'

  it('with nothing to warn about the strip renders nothing and its slot collapses', () => {
    const html = renderBoard(pageWritten(WRITTEN, 60_000))
    expect(html).toContain('<div class="warnings" id="slot-warnings"></div>')
    expect(html).not.toContain('class="warning-strip bevel"')
    expect(html).toContain('.warnings:empty { display: none; }')
  })

  it('a warning stands above SERVICES, at its level and escaped', () => {
    const html = renderBoard(pageWritten(WRITTEN, 60_000, [{ level: 'red', text: 'ctx <285k>' }, { level: 'amber', text: 'other' }]))
    expect(html).toContain('<span class="warning" data-level="red">ctx &lt;285k&gt;</span>')
    expect(html).toContain('<span class="warning" data-level="amber">other</span>')
    expect(html.indexOf('class="warning-strip bevel"')).toBeLessThan(html.indexOf('id="slot-services"'))
  })
})
