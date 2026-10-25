import type { BuildRunner, MorseApproval } from '../../ladder/hash.js'
import type { Preflight } from '../../ladder/preflight.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, BUS_DB_VARIABLE, openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { ghostLines, recordGhostLine } from '../../core/journal.js'
import { reduce } from '../../core/reducer.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { approverOf, revokeEvent } from '../../ladder/approval.js'
import { hashBrief, morseApprove } from '../../ladder/hash.js'
import { busWithCardStarted } from './card-started-bus.js'
import { ownBusPerTest } from './own-bus.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const HASH = path.join(REPO_ROOT, 'scripts/ladder/hash.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const NOW = new Date(2026, 9, 4, 12)
const CARD = 901
const BAND = 'p25–p75 100k–200k'
const IN_BAND = `expect: tokens ≈ 166k, minutes ≈ 12 — effort medium, n=61, median, ${BAND}`
const CARD_LINE = `#${CARD} task-${CARD} [implement/ghosts/S/cheap/owner] · depends — · blocks —`
const HEX = 'a'.repeat(64)

function directory(): string {
  return mkdtempSync(path.join(tmpdir(), 'ghosts-morse-'))
}

function briefText(expectLine: string, steps: string): string {
  return `/implement ${steps}\nSketch: none — independent implementation is the witness\n${expectLine}\n\nAcceptance: the name is printed — witness: \`echo name\``
}

interface Scenario {
  cardLine?: string
  touches?: string
  body?: string
  expectLine?: string
  steps?: string
  events?: object[]
  parked?: boolean
}

function admitBody(busPath: string, text: string): void {
  const db = openBus(busPath)
  try {
    appendEvent(db, { ts: NOW.toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: CARD_LINE, lane: 'lane-1', depends: [], text, textSha: textSha(text) }, legacy: false })
    reduce(db)
  }
  finally {
    db.close()
  }
}

interface World { brief: string, journalPath: string, busPath: string, runBuild: ReturnType<typeof vi.fn<BuildRunner>>, preflight: ReturnType<typeof vi.fn<Preflight>>, approvedPath: string }

ownBusPerTest()

function scenario(options: Scenario = {}): World {
  const busPath = busWithCardStarted([]).file
  process.env[BUS_DB_VARIABLE] = busPath
  for (const event of options.events ?? [])
    recordGhostLine('test', event, busPath)
  const root = directory()
  const brief = path.join(root, 'brief-t.md')
  writeFileSync(brief, `# head\n\n---\n\n${briefText(options.expectLine ?? IN_BAND, options.steps ?? 'Print the name.')}\n`)
  if (options.parked !== false)
    admitBody(busPath, parkingFileText({ card: options.cardLine ?? CARD_LINE, branch: `feat/${CARD}`, touches: [options.touches ?? 'src/thing/**'], continue: 'stop', who: 'shift', body: options.body ?? 'Do the thing.' }))
  const journalPath = path.join(root, 'ghosts.jsonl')
  return { brief, journalPath, busPath, runBuild: vi.fn<BuildRunner>(() => ({ status: 0, stderr: '' })), preflight: vi.fn<Preflight>(), approvedPath: `${brief.replace(/\.md$/, '')}.approved-sha256` }
}

function approveWithSuggestion(world: World): Promise<MorseApproval> {
  return morseApprove(world.brief, { card: CARD, cardBody: busCardBodies(world.busPath), journalPath: world.journalPath, now: NOW, runBuild: world.runBuild, preflight: world.preflight })
}

async function approve(world: World): Promise<string> {
  return (await approveWithSuggestion(world)).line
}

async function expectRefusal(world: World, message: RegExp): Promise<void> {
  const journalBefore = ghostLines(world.busPath)
  await expect(approve(world)).rejects.toThrow(message)
  expect(existsSync(world.approvedPath)).toBe(false)
  expect(ghostLines(world.busPath)).toEqual(journalBefore)
  expect(world.runBuild).not.toHaveBeenCalled()
}

function journalOf(world: World): Record<string, unknown>[] {
  return ghostLines(world.busPath)
}

async function expectApproved(world: World, risk: string): Promise<void> {
  const before = journalOf(world).length
  const line = await approve(world)
  const sha256 = hashBrief(world.brief)
  expect(line).toBe(`approved /implement text sha256: ${sha256} sketch: none (2026-10-04, morse)`)
  expect(readFileSync(world.approvedPath, 'utf8')).toBe(`${line}\n`)
  const events = journalOf(world)
  expect(existsSync(world.journalPath)).toBe(false)
  expect(events).toHaveLength(before + 1)
  expect(events.filter(event => event.event === 'approval')).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ event: 'approval', by: 'morse', card: CARD, brief: path.resolve(world.brief), sha256, sketch: 'none', risk, ts: NOW.toISOString() })
  expect(events.at(-1)!.forecast).toMatchObject({ kind: 'forecast', tokens: expect.any(Number) })
  expect(typeof events.at(-1)!.reason).toBe('string')
  expect(world.runBuild).toHaveBeenCalledTimes(1)
  expect(world.preflight).toHaveBeenCalledTimes(1)
}

function runHash(args: string[], home: string = directory()): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, HASH, ...args], { encoding: 'utf8', cwd: directory(), env: { ...process.env, HOME: home, CONSTRUCT_HANDOFF_DIR: directory() } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('the MORSE gate in process', () => {
  it('morse approves an R3 brief with a green preflight', async () => {
    await expectApproved(scenario({ touches: 'src/thing/**' }), 'R3')
  })

  it('morse approves an R2 brief and an R4 brief the same way', async () => {
    await expectApproved(scenario({ touches: 'contract/surface.json' }), 'R2')
    await expectApproved(scenario({ touches: 'docs/page.md' }), 'R4')
  })

  it('morse approves a forecast exactly at p75', async () => {
    await expectApproved(scenario({ expectLine: `expect: tokens ≈ 200k, minutes ≈ 12 — effort medium, n=61, median, ${BAND}` }), 'R3')
  })

  it('an R1 brief whose hard preflight is green is approved by morse', async () => {
    await expectApproved(scenario({ touches: 'templates/base/x.md' }), 'R1')
  })

  it('an R1 brief is approved when R4 and R1 touches are mixed', async () => {
    await expectApproved(scenario({ touches: 'docs/page.md, scripts/ladder/launch.ts' }), 'R1')
  })

  it('an R1 brief whose hard preflight is red is refused and writes nothing', async () => {
    const world = scenario({ touches: 'templates/base/x.md' })
    world.preflight.mockImplementation(() => {
      throw new Error('preflight: the base is red')
    })
    const journalBefore = ghostLines(world.busPath)
    await expect(approve(world)).rejects.toThrow(/the base is red/)
    expect(existsSync(world.approvedPath)).toBe(false)
    expect(ghostLines(world.busPath)).toEqual(journalBefore)
    expect(world.runBuild).toHaveBeenCalledTimes(1)
    expect(world.preflight).toHaveBeenCalledTimes(1)
  })

  it('the other conditions still bind an R1 card', async () => {
    await expectRefusal(scenario({ touches: 'templates/base/x.md', body: 'unclear: contour — not stated\n\nDo the thing.' }), /unclear field/)
    await expectRefusal(scenario({ touches: 'templates/base/x.md', events: [{ event: 'fall', card: CARD, kind: 'review-hole' }] }), /fell 1 time/)
    await expectRefusal(scenario({ touches: 'templates/base/x.md', expectLine: `expect: tokens ≈ 250k, minutes ≈ 12 — effort medium, n=61, median, ${BAND}` }), /above its p75/)
  })

  it('the stored risk: line is not trusted when it says R1 on R3 touches', async () => {
    await expectApproved(scenario({ touches: 'src/thing/**', body: 'risk: R1 — critical\n\nDo the thing.' }), 'R3')
  })

  it('the stored risk: line is not trusted when it says R4 on R1 touches', async () => {
    await expectApproved(scenario({ touches: 'templates/base/x.md', body: 'risk: R4 — low\n\nDo the thing.' }), 'R1')
  })

  it('morse refuses a brief with a fall on its card', async () => {
    await expectRefusal(scenario({ events: [{ event: 'fall', card: CARD, kind: 'review-hole' }] }), /fell 1 time.*review-hole/)
  })

  it('a fall on another card does not stop morse', async () => {
    await expectApproved(scenario({ events: [{ event: 'fall', card: CARD + 1, kind: 'review-hole' }] }), 'R3')
  })

  it('morse refuses a card with an unclear field', async () => {
    await expectRefusal(scenario({ body: 'unclear: contour — not stated\n\nDo the thing.' }), /unclear field/)
  })

  it('an unclear word inside prose is not an unclear field', async () => {
    await expectApproved(scenario({ body: 'Do the thing; the unclear: part is prose.' }), 'R3')
  })

  it('morse refuses a forecast above p75', async () => {
    await expectRefusal(scenario({ expectLine: `expect: tokens ≈ 250k, minutes ≈ 12 — effort medium, n=61, median, ${BAND}` }), /above its p75/)
  })

  it('morse refuses an expect line of none', async () => {
    await expectRefusal(scenario({ expectLine: 'expect: none — n=3 for effort low' }), /expect: line is none/)
  })

  it('morse refuses a forecast with no band', async () => {
    await expectRefusal(scenario({ expectLine: 'expect: tokens ≈ 166k, minutes ≈ 12 — effort medium, n=61, median' }), /no p25–p75 band/)
  })

  it('morse refuses a brief whose approval was revoked', async () => {
    const world = scenario()
    recordGhostLine('test', revokeEvent(hashBrief(world.brief), CARD, NOW.toISOString()), world.busPath)
    await expectRefusal(world, /was revoked/)
  })

  it('a revoke for another hash does not stop morse', async () => {
    await expectApproved(scenario({ events: [revokeEvent(HEX, CARD, NOW.toISOString())] }), 'R3')
  })

  it('morse refuses a card the bus holds no body of', async () => {
    await expectRefusal(scenario({ parked: false }), new RegExp(`the bus holds no card body of card #${CARD}`))
  })

  it('refuses a brief that restates its card, naming the line it copied', async () => {
    const body = `Every run prints the name of the card.\n\nWitnesses:\nAcceptance: the name is printed — witness: \`echo name\``
    await expectRefusal(scenario({ body, steps: 'Every run prints the name of the card.' }), new RegExp(`restates card #${CARD} verbatim \\('Every run prints the name of the card\\.'\\)`))
  })

  it('accepts a brief of a card reference, a sketch and steps, carrying the card\'s witnesses', async () => {
    const body = `Every run prints the name of the card.\n\nWitnesses:\nAcceptance: the name is printed — witness: \`echo name\``
    await expectApproved(scenario({ body, steps: `#${CARD}: add the print to the run, then witness it.` }), 'R3')
  })

  it('morse leaves no approval file when the bus cannot be written', async () => {
    const world = scenario()
    const notADirectory = path.join(directory(), 'file')
    writeFileSync(notADirectory, '')
    process.env[BUS_DB_VARIABLE] = path.join(notADirectory, 'bus.db')
    await expect(approve(world)).rejects.toThrow(/the bus cannot be written .* no approval file was written/)
    expect(existsSync(world.approvedPath)).toBe(false)
  })

  it('morse leaves an approval the owner already wrote on the same hash', async () => {
    const world = scenario()
    const ownerLine = `approved /implement text sha256: ${hashBrief(world.brief)} sketch: none (2026-10-01, Eli)\n`
    writeFileSync(world.approvedPath, ownerLine)
    await expect(approve(world)).rejects.toThrow(/approved by Eli/)
    expect(readFileSync(world.approvedPath, 'utf8')).toBe(ownerLine)
    expect(ghostLines(world.busPath)).toEqual([])
    expect(world.runBuild).not.toHaveBeenCalled()
  })
})

function ladderCard(size: string): string {
  return `#${CARD} task-${CARD} [implement/ghosts/${size}/ladder/owner] · depends — · blocks —`
}

function forecastOf(minutes: number): string {
  return `expect: tokens ≈ 166k, minutes ≈ ${minutes} — effort medium, n=61, median, ${BAND}`
}

function suggestionsOf(world: World): Record<string, unknown>[] {
  return journalOf(world).filter(event => event.event === 'suggestion')
}

describe('mORSE suggests a cheaper contour', () => {
  it('suggests cheap for a small ladder card', async () => {
    for (const size of ['S', 'M']) {
      const world = scenario({ cardLine: ladderCard(size), expectLine: forecastOf(17) })
      const approval = await approveWithSuggestion(world)
      const suggestions = suggestionsOf(world)
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0]).toMatchObject({ by: 'morse', card: CARD, contour: 'ladder', suggests: 'cheap', ts: NOW.toISOString() })
      expect(suggestions[0]!.line).toBe(approval.suggestion)
      expect(approval.suggestion).toMatch(/^mechanism: ladder, I suggest cheap, because /)
      expect(approval.suggestion).toContain(`size ${size}`)
      expect(approval.suggestion).toContain('difference ≈92k tokens / 12 minutes')
    }
  })

  it('leaves the contour unchanged', async () => {
    const world = scenario({ cardLine: ladderCard('S'), expectLine: forecastOf(17) })
    const parkedBefore = busCardBodies(world.busPath)(CARD)
    const approval = await approveWithSuggestion(world)
    expect(approval.suggestion).toBeDefined()
    expect(busCardBodies(world.busPath)(CARD)).toBe(parkedBefore)
    expect(readFileSync(world.approvedPath, 'utf8')).toBe(`${approval.line}\n`)
    expect(journalOf(world).filter(event => event.event === 'approval')).toHaveLength(1)
    expect(approval.suggestion).toContain('the contour stays as the card says')
  })

  it('no suggestion above the threshold or for size L', async () => {
    const cases = [
      { cardLine: ladderCard('S'), expectLine: forecastOf(64) },
      { cardLine: ladderCard('M'), expectLine: forecastOf(90) },
      { cardLine: ladderCard('L'), expectLine: forecastOf(17) },
      { cardLine: ladderCard('XS'), expectLine: forecastOf(17) },
      { cardLine: CARD_LINE, expectLine: forecastOf(17) },
    ]
    for (const options of cases) {
      const world = scenario(options)
      const approval = await approveWithSuggestion(world)
      expect(approval.suggestion).toBeUndefined()
      expect(suggestionsOf(world)).toHaveLength(0)
      expect(existsSync(world.approvedPath)).toBe(true)
    }
  })
})

describe('ghosts:hash for MORSE from the command line', () => {
  it('the flag --by morse needs --card', () => {
    const brief = scenario().brief
    for (const by of ['morse', 'MORSE']) {
      const result = runHash([brief, '--by', by])
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('--card')
      expect(result.stderr).not.toContain('check-acceptance')
    }
  })

  it('the flag --card needs --by morse', () => {
    const brief = scenario().brief
    for (const args of [['--card', String(CARD)], ['--by', 'Someone', '--card', String(CARD)], ['--by', 'morse', '--card', 'abc']]) {
      const result = runHash([brief, ...args])
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(args[0] === '--by' && args.includes('abc') ? '--card' : args[0]!)
      expect(result.stderr).not.toContain('check-acceptance')
    }
  })

  it('morse reads the card body from the bus', () => {
    const world = scenario({ touches: 'templates/base/x.md', body: 'unclear: contour — not stated\n\nDo the thing.' })
    const result = runHash([world.brief, '--by', 'morse', '--card', String(CARD)])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/unclear field/)
    expect(existsSync(world.approvedPath)).toBe(false)
  })
})

describe('approverOf', () => {
  it('approverOf reads morse, an owner name and an old-format line', () => {
    expect(approverOf(`approved /implement text sha256: ${HEX} sketch: none (2026-10-04, morse)\n`)).toBe('morse')
    expect(approverOf(`approved /implement text sha256: ${HEX} sketch: none (2026-10-04, Approver One)\n`)).toBe('Approver One')
    expect(approverOf(`approved /implement text sha256: ${HEX} (2026-09-27, Eli)`)).toBe('Eli')
  })

  it('approverOf is undefined for a line with no closing date and name', () => {
    expect(approverOf(`approved /implement text sha256: ${HEX} sketch: none\n`)).toBeUndefined()
    expect(approverOf(`approved /implement text sha256: ${HEX} (2026-10-04)\n`)).toBeUndefined()
    expect(approverOf('nothing here')).toBeUndefined()
  })
})
