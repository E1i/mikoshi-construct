import type { Lease } from '../../core/lease.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBodyCard, SIZES } from '../../../src/card/grammar.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'
import { SESSION_HEARTBEAT } from '../../core/events.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { reachedContextLine } from '../../nodes/launch/continuation.js'
import { realStarterPorts } from '../../nodes/launch/launch-worker.js'
import { COMPACT_WINDOW_VARIABLE } from '../../ports/client/claude/adapter.js'
import { CARD_SIZE_VARIABLE, cardSessionOverlay, cardSizeIn, sessionEnv } from '../../ports/session.js'
import { PROJECT_VARIABLE, realExitReadings } from '../../window/eddies-measure.js'

const HOOK = path.resolve(import.meta.dirname, '../../../templates/ai/claude/scripts/construct/eddies.mjs')
const UNKNOWN_SIZE_LINE = 120_000
const L_LINE = 500_000
const M_LINE = 150_000
const COMPACT_WINDOW = 250_000
const MODEL = 'claude-opus-5-5'
const LIMITS = {
  contextLimit: 250_000,
  cardContextLine: UNKNOWN_SIZE_LINE,
  cardContextLineBySize: { XS: M_LINE, S: M_LINE, M: M_LINE, L: L_LINE },
  sessionSpend: 30_000_000,
  agentSpend: 20_000_000,
  runSpend: 30_000_000,
  warnRatio: 0.8,
  modelWindows: { [MODEL]: 1_000_000 },
}
const NOW = new Date('2026-11-07T08:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function eddiesFileIn(root: string): string {
  return path.join(root, '.claude/eddies.json')
}

function treeWithLimits(limits: object = LIMITS, compactWindow: number | null = COMPACT_WINDOW): string {
  const root = mkdtempSync(path.join(tmpdir(), 'card-line-by-size-'))
  roots.push(root)
  mkdirSync(path.dirname(eddiesFileIn(root)))
  writeFileSync(eddiesFileIn(root), JSON.stringify(limits))
  if (compactWindow !== null)
    writeFileSync(path.join(path.dirname(eddiesFileIn(root)), 'settings.json'), JSON.stringify({ autoCompactWindow: compactWindow }))
  return root
}

function transcriptAt(root: string, session: string, context: number): string {
  const file = path.join(root, 'projects', `${session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', model: MODEL, usage: { input_tokens: context, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`)
  return file
}

function hookOn(root: string, session: string, context: number, size: string | null): void {
  const input = JSON.stringify({ session_id: session, transcript_path: transcriptAt(root, session, context), tool_name: 'Bash', tool_input: { command: 'ls' } })
  const { [CARD_SIZE_VARIABLE]: _inherited, ...base } = process.env
  const run = spawnSync(process.execPath, [HOOK, 'guard'], { input, encoding: 'utf8', env: { ...base, CLAUDE_PROJECT_DIR: root, CONSTRUCT_CARD: '1', CONSTRUCT_HANDOFF_DIR: root, ...(size === null ? {} : { [CARD_SIZE_VARIABLE]: size }) } })
  expect(run.status, run.stderr).toBe(0)
}

function warnOf(root: string, size: string | null): unknown {
  return realExitReadings({ CONSTRUCT_CARD: '1', ...(size === null ? {} : { [CARD_SIZE_VARIABLE]: size }) }, root, root, path.join(root, 'bus.db')).contextWarn
}

function cardLine(id: number, size: string): string {
  return `card: #${id} sized [implement/netwatch/${size}/cheap/owner] · depends — · blocks —`
}

describe('the line follows the size of the card', () => {
  it('an L session at 300k keeps working and stops at 500k', () => {
    const root = treeWithLimits()
    hookOn(root, 'l-low', 300_000, 'L')
    expect(reachedContextLine(root, 'l-low')).toBe(false)
    hookOn(root, 'l-high', L_LINE, 'L')
    expect(reachedContextLine(root, 'l-high')).toBe(true)
    expect(warnOf(root, 'L')).toBe(L_LINE)
  })

  it('a session of unknown size stops at cardContextLine', () => {
    for (const size of [null, 'XXL', 'constructor']) {
      const root = treeWithLimits()
      hookOn(root, 'low', UNKNOWN_SIZE_LINE - 1, size)
      expect(reachedContextLine(root, 'low'), String(size)).toBe(false)
      hookOn(root, 'high', UNKNOWN_SIZE_LINE, size)
      expect(reachedContextLine(root, 'high'), String(size)).toBe(true)
      expect(warnOf(root, size), String(size)).toBe(UNKNOWN_SIZE_LINE)
    }
  })

  it('an M session stops at 150k', () => {
    const root = treeWithLimits()
    hookOn(root, 'm-low', M_LINE - 1, 'M')
    expect(reachedContextLine(root, 'm-low')).toBe(false)
    hookOn(root, 'm-high', M_LINE, 'M')
    expect(reachedContextLine(root, 'm-high')).toBe(true)
    expect(warnOf(root, 'M')).toBe(M_LINE)
  })

  it('the sizes XS and S take the line the card names for them', () => {
    const root = treeWithLimits()
    for (const size of ['XS', 'S'])
      expect(warnOf(root, size), size).toBe(M_LINE)
  })

  it('a config with no line by size keeps cardContextLine for every size', () => {
    const { cardContextLineBySize: _bySize, ...old } = LIMITS
    const root = treeWithLimits(old)
    hookOn(root, 'old', UNKNOWN_SIZE_LINE, 'L')
    expect(reachedContextLine(root, 'old')).toBe(true)
    expect(warnOf(root, 'L')).toBe(UNKNOWN_SIZE_LINE)
  })

  it('a line by size that is not a positive number refuses the tool call and names the key', () => {
    const root = treeWithLimits({ ...LIMITS, cardContextLineBySize: { L: 'soon' } })
    const input = JSON.stringify({ session_id: 'bad', transcript_path: transcriptAt(root, 'bad', 1000), tool_name: 'Bash', tool_input: { command: 'ls' } })
    const run = spawnSync(process.execPath, [HOOK, 'guard'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, CONSTRUCT_CARD: '1', CONSTRUCT_HANDOFF_DIR: root } })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('config-cardContextLineBySize-invalid')
  })

  it('the source of the line names the size it was read for', () => {
    const root = treeWithLimits()
    const source = (size: string | null): unknown => realExitReadings({ CONSTRUCT_CARD: '1', ...(size === null ? {} : { [CARD_SIZE_VARIABLE]: size }) }, root, root, path.join(root, 'bus.db')).contextWarnSource
    expect(source('L')).toBe('.claude/eddies.json cardContextLineBySize.L')
    expect(source(null)).toBe('.claude/eddies.json cardContextLine')
  })

  it('the coordinating window ignores a size in its environment', () => {
    const root = treeWithLimits()
    expect(realExitReadings({ [CARD_SIZE_VARIABLE]: 'L' }, root, root, path.join(root, 'bus.db')).contextWarn).toBe(LIMITS.contextLimit * LIMITS.warnRatio)
  })
})

describe('compaction of a card session', () => {
  it('a card session compacts above its line', () => {
    const root = treeWithLimits()
    const overlay = cardSessionOverlay(root, {}, 'L')
    expect(Number(overlay[COMPACT_WINDOW_VARIABLE])).toBeGreaterThan(L_LINE)
    expect(sessionEnv({}, 1, overlay)).toMatchObject({ [CARD_SIZE_VARIABLE]: 'L', [COMPACT_WINDOW_VARIABLE]: overlay[COMPACT_WINDOW_VARIABLE] })
  })

  it('a card session whose line is under the window keeps the window it has', () => {
    const root = treeWithLimits()
    expect(cardSessionOverlay(root, {}, 'M')).toEqual({ [CARD_SIZE_VARIABLE]: 'M' })
    expect(cardSessionOverlay(root, {}, null)).toEqual({})
  })

  it('a window from the environment is read before the setting, in both directions', () => {
    const root = treeWithLimits()
    expect(cardSessionOverlay(root, { [COMPACT_WINDOW_VARIABLE]: '900000' }, 'L')).toEqual({ [CARD_SIZE_VARIABLE]: 'L' })
    expect(Number(cardSessionOverlay(treeWithLimits(LIMITS, 900_000), { [COMPACT_WINDOW_VARIABLE]: '400000' }, 'L')[COMPACT_WINDOW_VARIABLE])).toBeGreaterThan(L_LINE)
  })

  it('no declared window asks for no override', () => {
    expect(cardSessionOverlay(treeWithLimits(LIMITS, null), {}, 'L')).toEqual({ [CARD_SIZE_VARIABLE]: 'L' })
  })
})

describe('the session carries the size of its card', () => {
  it('reads the size from the card line of a card body', () => {
    expect(cardSizeIn(`${cardLine(5, 'L')}\nbranch: feat/x\n\ntext`)).toBe('L')
    expect(cardSizeIn('no card line here')).toBeNull()
    expect(cardSizeIn(null)).toBeNull()
  })

  it('reads the same size the card grammar reads, on every size and both forms of the line', () => {
    for (const size of SIZES) {
      for (const body of [cardLine(9, size), cardLine(9, size).slice('card: '.length), `${cardLine(9, size)}\nbody`]) {
        const parsed = readBodyCard(body)
        expect(cardSizeIn(body), body).toBe(parsed.kind === 'card' ? parsed.card.size : null)
      }
    }
  })

  it('a launch session carries it and a card with no readable size does not', () => {
    const root = treeWithLimits()
    const ports = realStarterPorts(root, {}, '', () => 'u', id => id === 1 ? cardLine(1, 'L') : null, () => [], null, path.join(root, 'bus.db'))
    expect(ports.envOf(1)).toMatchObject({ [CARD_SIZE_VARIABLE]: 'L', CONSTRUCT_CARD: '1' })
    expect(Number(ports.envOf(1)[COMPACT_WINDOW_VARIABLE])).toBeGreaterThan(L_LINE)
    expect(ports.envOf(2)).not.toHaveProperty(CARD_SIZE_VARIABLE)
  })

  it('an inherited size never reaches a card session of another card', () => {
    expect(sessionEnv({ [CARD_SIZE_VARIABLE]: 'L' } as NodeJS.ProcessEnv, 1)).not.toHaveProperty(CARD_SIZE_VARIABLE)
  })

  it('an answer session carries it, and its context warn is read for that size', async () => {
    const root = treeWithLimits()
    vi.stubEnv(PROJECT_VARIABLE, root)
    const asked: (string | null)[] = []
    const seen: NodeJS.ProcessEnv[] = []
    const answerer = claudeAnswerer(path.join(root, 'answers'), {
      cardText: () => cardLine(7, 'L'),
      available: () => true,
      remoteHead: () => 'a'.repeat(40),
      spawn: async (run) => {
        seen.push(run.env)
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ended' })}\n`)
        return 0
      },
      newSession: () => 'fresh-session',
      publish: () => {},
      context: () => 1000,
      contextWarn: (size) => {
        asked.push(size)
        return L_LINE
      },
    })
    const lease = { cardId: 7, leaseGen: 1, head: 'a'.repeat(40), pr: 3, queue: 'answer', taskKey: 'answer:7' } as unknown as Lease
    const source = { kind: 'changes', findings: [], events: [], decisions: [] }
    await answerer({ card: { session: 'card-session', worktree: root, branch: 'feat/x', pr: 3 }, lease, source, widened: null } as unknown as Parameters<typeof answerer>[0])
    expect(seen[0]).toMatchObject({ [CARD_SIZE_VARIABLE]: 'L' })
    expect(Number(seen[0]![COMPACT_WINDOW_VARIABLE])).toBeGreaterThan(L_LINE)
    expect(asked).toEqual(['L', 'L'])
  })
})

describe('the board reads each card under its own line', () => {
  function pageOver(root: string, events: { card: number, context: number }[]): string {
    const file = path.join(root, 'bus.db')
    writeBus(file, {
      cards: [{ id: 1801, state: 'running', lane: 'lane-1', line: cardLine(1801, 'L'), since: '2026-11-07T07:00:00.000Z' }, { id: 1802, state: 'running', lane: 'lane-2', line: cardLine(1802, 'M'), since: '2026-11-07T07:00:00.000Z' }, { id: 1803, state: 'running', lane: 'lane-3', line: '#1803 no size', since: '2026-11-07T07:00:00.000Z' }],
      roles: [{ role: 'operator', status: 'idle', state: 'awake' }],
      events: [{ ts: '2026-11-07T07:59:00.000Z', type: 'netwatch.tick', card: null, payload: '{}' }, ...events.map(({ card, context }) => ({ ts: '2026-11-07T07:57:00.000Z', type: SESSION_HEARTBEAT, card, payload: JSON.stringify({ step: 'launch', session: `s-${card}`, context, model: MODEL }) }))],
    })
    const db = new DatabaseSync(file)
    db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
    db.close()
    let html = ''
    expect(printBoard(file, NOW, (text) => {
      html += text
    }, path.join(root, 'miko.md'), 'html', eddiesFileIn(root))).toBe(0)
    return html
  }

  it('an L card at 300k is not past its line while an M card at 300k is', () => {
    const html = pageOver(treeWithLimits(), [{ card: 1801, context: 300_000 }, { card: 1802, context: 300_000 }])
    expect(html).not.toContain('#1801: ctx')
    expect(html).toContain('#1802: ctx 300k of 150k, over the limit')
  })

  it('a card with no readable size is read under cardContextLine', () => {
    const html = pageOver(treeWithLimits(), [{ card: 1803, context: 300_000 }])
    expect(html).toContain('#1803: ctx 300k of 120k, over the limit')
  })

  it('names the sizes whose line differs from cardContextLine beside it', () => {
    const html = pageOver(treeWithLimits({ ...LIMITS, cardContextLine: M_LINE }), [])
    expect(html).toContain('card line <b>150k</b> · L <b>500k</b>')
    expect(html).not.toContain(' · M <b>')
  })
})
