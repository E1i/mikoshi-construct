import type { BusService, CrawlerReading } from '../../../src/commands/board/bus.js'
import type { MikoPanelParts, MikoPresence } from '../../cli/board-page/miko-panel.js'
import type { SessionCardParts, SessionView, TranscriptAction } from '../../cli/board-page/session-card.js'
import { describe, expect, it } from 'vitest'
import { crawlerRow, handoffSize, mikoPanel, windowLine } from '../../cli/board-page/miko-panel.js'
import { NO_SESSION_VIEW, roundClock, roundPhase, sessionCard, stateLine, terminalOf } from '../../cli/board-page/session-card.js'

const NOW = new Date('2026-10-20T08:00:00.000Z')
const EXPECTED_MS = 20 * 60_000
const ANSWER: BusService = { role: 'answer', task: '#861', tree: null, step: 'answer · pulse 1 min ago', session: 's-one' }
const PARTS: SessionCardParts = { opener: '', hint: '', bars: '', agents: '', over: false, now: NOW.toISOString() }
const WINDOW: BusService = { role: 'window', task: 'miko', tree: null, step: 'window · awake' }
const PRESENCE: MikoPresence = { model: null, core: null, status: null, handoffBytes: null, skills: [], crawlers: [] }
const PANEL: MikoPanelParts = { windows: [WINDOW], bars: () => '', presence: PRESENCE, now: NOW.toISOString(), words: { role: 'FIXER', name: 'Miko', plainTitle: '' }, opener: '', hint: '', idle: null }
const CRAWLER: CrawlerReading = { id: 'a1', kind: 'review', description: null, startedAt: null, state: 'IDLE', context: null, spent: null }

function startedBefore(ms: number, expectedMs: number | null = null): SessionView {
  return { startedAt: new Date(NOW.getTime() - ms).toISOString(), expectedMs, steps: [], terminal: null }
}

function stepNow(html: string): string {
  return /<span class="round-step-now">([^<]*)<\/span>/.exec(html)![1]!
}

function clockIn(html: string): string {
  return /<span class="round-clock">([^<]*)<\/span>/.exec(html)![1]!
}

function action(name: string, ended: boolean, id: string | null = null): TranscriptAction {
  return { id, name, detail: `${name} detail`, at: NOW.toISOString(), endedAt: ended ? NOW.toISOString() : null }
}

function terminalFrom(text: string, read: TranscriptAction[]): ReturnType<typeof terminalOf> {
  return terminalOf(text, () => read)
}

describe('the state line of a session card', () => {
  it('an over-budget session reads OVER BUDGET whatever its step says', () => {
    expect(stateLine('answer · now Bash ls', true)).toBe('<div class="svc-state" data-state="over">OVER BUDGET</div>')
  })

  it('a session with a current action reads ACTING', () => {
    expect(stateLine('answer · pulse 1 min ago · now Bash ls for 2 min', false)).toBe('<div class="svc-state" data-state="acting">ACTING</div>')
  })

  it('a waiting session names its cause in capitals', () => {
    expect(stateLine('answer · waits on the review for 3 min', false)).toBe('<div class="svc-state" data-state="waiting">WAITING · REVIEW</div>')
  })

  it('a waiting session with no readable cause reads CAUSE UNKNOWN', () => {
    expect(stateLine('answer · pulse 1 min ago', false)).toBe('<div class="svc-state" data-state="waiting">WAITING · CAUSE UNKNOWN</div>')
  })
})

describe('the round clock and phase', () => {
  it('exactly 80 percent of the round is the warn phase, just under it is calm', () => {
    expect(roundPhase(0.8)).toBe('warn')
    expect(roundPhase(0.7999)).toBe('calm')
    expect(roundPhase(null)).toBe('none')
  })

  it('the clock shows the centiseconds', () => {
    expect(roundClock(61_234)).toBe('01:01.23')
    expect(roundClock(999)).toBe('00:00.99')
  })

  it('a negative clock value reads zero', () => {
    expect(roundClock(-1_234)).toBe('00:00.00')
  })

  it('a card with no round start shows the empty clock', () => {
    expect(clockIn(sessionCard(ANSWER, NO_SESSION_VIEW, PARTS))).toBe('--:--.--')
  })

  it('a round start in the future counts as no time elapsed', () => {
    const future = startedBefore(-5 * 60_000, EXPECTED_MS)
    expect(clockIn(sessionCard(ANSWER, future, PARTS))).toBe('20:00.00')
    expect(clockIn(sessionCard(ANSWER, startedBefore(-5 * 60_000), PARTS))).toBe('00:00.00')
  })
})

describe('the round steps of a session card', () => {
  it('a step of exactly one minute reads in minutes', () => {
    expect(stepNow(sessionCard(ANSWER, startedBefore(60_000), PARTS))).toBe('lease · 1 min')
  })

  it('the seconds of a step are rounded, not cut', () => {
    expect(stepNow(sessionCard(ANSWER, startedBefore(44_600), PARTS))).toBe('lease · 45s')
  })

  it('a step whose round starts in the future reads zero seconds', () => {
    expect(stepNow(sessionCard(ANSWER, startedBefore(-5 * 60_000), PARTS))).toBe('lease · 0s')
  })

  it('a runner other than answer shows no round-steps line', () => {
    for (const role of ['launch', 'review'])
      expect(sessionCard({ ...ANSWER, role }, startedBefore(60_000), PARTS)).not.toContain('round-steps')
    expect(sessionCard(ANSWER, startedBefore(60_000), PARTS)).toContain('round-steps')
  })
})

describe('the terminal block of a session card', () => {
  it('the terminal picks the last open action over an earlier open one and a later ended one', () => {
    expect(terminalFrom('', [action('first', false), action('second', false), action('third', true)])?.name).toBe('second')
  })

  it('with every action ended the terminal picks the last one', () => {
    expect(terminalFrom('', [action('first', true), action('second', true)])?.name).toBe('second')
  })

  it('an action without an id shows its detail, not a transcript line', () => {
    const text = JSON.stringify({ message: { content: [{ id: null, input: { command: 'from the transcript' } }] } })
    expect(terminalFrom(text, [action('Bash', false)])?.command).toBe('Bash detail')
  })
})

describe('the crawler row', () => {
  it('the tenth crawler is numbered #10 and a crawler with only a context shows no SPENT', () => {
    expect(crawlerRow({ ...CRAWLER, context: 1_000 }, 9, NOW.toISOString())).toContain('CRAWLER #10 · review</span>')
    expect(crawlerRow({ ...CRAWLER, context: 1_000 }, 9, NOW.toISOString())).toContain('<div class="crawler-use">CTX 1k</div>')
  })

  it('a crawler with neither description nor start time shows no what line and never a dash', () => {
    const html = crawlerRow(CRAWLER, 0, NOW.toISOString())
    expect(html).not.toContain('crawler-what')
    expect(html).not.toContain('—')
  })
})

describe('the Miko strip', () => {
  it('the hint sits only on the first window', () => {
    const html = mikoPanel({ ...PANEL, windows: [WINDOW, { ...WINDOW, task: 'second' }], hint: '<i data-hint></i>' })
    expect(html.match(/data-hint/g)).toHaveLength(1)
    expect(html.indexOf('data-hint')).toBeLessThan(html.lastIndexOf('miko-self'))
  })

  it('the window line hides every missing part and is absent when none is known', () => {
    expect(windowLine(PRESENCE)).toBe('')
    expect(windowLine({ ...PRESENCE, status: 'CONTINUE' })).toBe('<div class="svc-line miko-window">status [CONTINUE]</div>')
    expect(windowLine({ ...PRESENCE, core: 7, handoffBytes: 1_023 })).toBe('<div class="svc-line miko-window">window v7 · handoff 1023 B</div>')
  })

  it('a handoff of exactly one kilobyte reads in KB', () => {
    expect(handoffSize(1_024)).toBe('1 KB')
    expect(handoffSize(3_584)).toBe('3.5 KB')
  })
})
