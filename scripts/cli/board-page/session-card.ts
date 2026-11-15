import type { BusService, SubagentReading } from '../../../src/commands/board/bus.js'

export interface Gauges {
  context: number | null
  spent: number | null
  model: string | null
}

export interface EddiesLimits {
  contextLimit: number | null
  cardContextLine: number | null
  cardLineBySize?: ReadonlyMap<string, number>
  sessionSpend: number | null
  agentSpend: number | null
  warnRatio: number | null
  modelWindows: ReadonlyMap<string, number>
}

export interface RoundStep {
  step: string
  seconds: number
}

export interface Terminal {
  name: string
  at: string
  endedAt: string | null
  command: string
}

export interface SessionView {
  startedAt: string | null
  expectedMs: number | null
  steps: RoundStep[]
  terminal: Terminal | null
}

export interface TranscriptAction {
  id: string | null
  name: string
  detail: string | null
  at: string
  endedAt: string | null
}

export interface AgentWords {
  pulse: (minutes: number) => string
  line: (count: number, largest: string, limit: string) => string
}

export interface SessionCardParts {
  opener: string
  hint: string
  bars: string
  agents: string
  over: boolean
  now: string
}

export type RoundPhase = 'none' | 'calm' | 'warn' | 'over'

export const ROUND_COLOURS = { calm: '#5ce1e6', warn: '#f5c84b', over: '#ff4d6d', warnShare: 0.8 } as const
export const ROUND_LABELS = { remaining: 'ROUND TIME REMAINING', overTime: 'OVER TIME', elapsed: 'ROUND TIME ELAPSED' } as const
export const ROUND_STEPS = ['lease', 'tree', 'spawn', 'think', 'gate', 'push'] as const
export const CARD_TASK = /^#(\d+)$/

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
export const STEPPED_ROLE = 'answer'
const NONE = '—'
const NO_DATA = 'no data'
const THOUSAND = 1_000
const MILLION = 1_000_000
const SECOND_MS = 1_000
export const MINUTE_MS = 60_000
const TIME_OF_DAY = { from: 11, to: 19 } as const
const HEX_CHANNELS = [1, 3, 5] as const
const INPUT_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'description'] as const
const PULSE_PART = /pulse \d+ min ago/
const WAIT_CAUSE = /waits on the (.+?) for \d+ min/
const ACTING_PART = / · now \S/
const AGENT_HEAT = ['', ' data-hot', ' data-over'] as const
export const NO_SESSION_VIEW: SessionView = { startedAt: null, expectedMs: null, steps: [], terminal: null }

export function escaped(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char]!)
}

export function compact(value: number): string {
  if (value >= MILLION)
    return `${Number((value / MILLION).toFixed(1))}M`
  return value >= THOUSAND ? `${Math.round(value / THOUSAND)}k` : String(value)
}

export function percent(ratio: number): string {
  return `${Math.min(100, Math.round(ratio * 100))}%`
}

export function eddiesBar(name: string, value: number | null, denominator: number | null, limit: number | null, warnRatio: number | null): string {
  if (value === null)
    return ''
  const reading = denominator === null ? compact(value) : `${compact(value)}/${compact(denominator)}`
  const over = limit !== null && value > limit
  const warnAt = limit === null || warnRatio === null ? null : limit * warnRatio
  const hot = !over && warnAt !== null && value >= warnAt
  const bar = denominator === null ? '<span></span>' : `<span class="edd-bar" style="--_fill: ${percent(value / denominator)}${warnAt === null ? '' : `; --_warn: ${percent(warnAt / denominator)}`}"></span>`
  return `<div class="edd"${over ? ' data-over' : hot ? ' data-hot' : ''}><span class="edd-k">${name}</span>${bar}<span class="edd-v">${reading}</span></div>`
}

const compactOrNone = (value: number | null): string => value === null ? NONE : compact(value)
const heatOf = (value: number | null, limit: number | null, warn: number | null): number => value === null || limit === null ? 0 : value >= limit ? 2 : Number(warn !== null && value >= limit * warn)
const agentHeat = (agent: SubagentReading, limits: EddiesLimits): number => Math.max(heatOf(agent.context, limits.contextLimit, limits.warnRatio), heatOf(agent.spent, limits.agentSpend, limits.warnRatio))

export function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / MINUTE_MS))
}

export function clockOf(stamp: string): string {
  return stamp.slice(TIME_OF_DAY.from, TIME_OF_DAY.to)
}

function agentRow(agent: SubagentReading, at: string, limits: EddiesLimits, words: AgentWords): string {
  const pulse = agent.at === null ? NONE : words.pulse(minutesBetween(agent.at, at))
  return `<li${AGENT_HEAT[agentHeat(agent, limits)]}><span class="svc-agent-name">${escaped(agent.name)}</span><span>CTX ${compactOrNone(agent.context)}</span><span>SPENT ${compactOrNone(agent.spent)}</span><span>${escaped(pulse)}</span></li>`
}

export function agentsLine(service: BusService, at: string, limits: EddiesLimits, words: AgentWords): string {
  const agents = service.subagents ?? []
  if (agents.length === 0)
    return ''
  const largest = Math.max(...agents.map(agent => agent.spent ?? 0))
  const heaviest = Math.max(...agents.map(agent => agentHeat(agent, limits)))
  return [
    `<button type="button" class="svc-agents" data-agents="${escaped(service.session ?? service.task)}" aria-expanded="false"${AGENT_HEAT[heaviest]}>${escaped(words.line(agents.length, compact(largest), compactOrNone(limits.agentSpend)))}</button>`,
    `<ul class="svc-agent-list" data-agents-list>${agents.map(agent => agentRow(agent, at, limits, words)).join('')}</ul>`,
  ].join('')
}

function channels(hex: string): number[] {
  return HEX_CHANNELS.map(from => Number.parseInt(hex.slice(from, from + 2), 16))
}

function mixed(from: string, to: string, share: number): string {
  const [start, end] = [channels(from), channels(to)]
  return `#${start.map((channel, index) => Math.round(channel + (end[index]! - channel) * share).toString(16).padStart(2, '0')).join('')}`
}

export function roundColour(share: number): string {
  const { calm, warn, over, warnShare } = ROUND_COLOURS
  if (share >= 1)
    return over
  const bounded = Math.max(0, share)
  return bounded < warnShare ? mixed(calm, warn, bounded / warnShare) : mixed(warn, over, (bounded - warnShare) / (1 - warnShare))
}

export function roundPhase(share: number | null): RoundPhase {
  if (share === null)
    return 'none'
  return share >= 1 ? 'over' : share >= ROUND_COLOURS.warnShare ? 'warn' : 'calm'
}

export function roundClock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms))
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(whole / MINUTE_MS))}:${pad(Math.floor(whole % MINUTE_MS / SECOND_MS))}.${pad(Math.floor(whole % SECOND_MS / 10))}`
}

function fullInputOf(text: string, action: TranscriptAction): string | null {
  if (action.id === null)
    return null
  for (const raw of text.split('\n').filter(line => line.includes(action.id!))) {
    try {
      const content = (JSON.parse(raw) as { message?: { content?: unknown } }).message?.content
      const use = Array.isArray(content) ? (content as { id?: unknown, input?: Record<string, unknown> }[]).find(item => item?.id === action.id) : undefined
      const found = INPUT_FIELDS.map(field => use?.input?.[field]).find(value => typeof value === 'string' && value.trim() !== '')
      if (typeof found === 'string')
        return found
    }
    catch {}
  }
  return null
}

export function terminalOf(text: string | null, actions: (text: string) => readonly TranscriptAction[]): Terminal | null {
  if (text === null)
    return null
  const read = actions(text)
  const action = read.filter(one => one.endedAt === null).at(-1) ?? read.at(-1)
  if (action === undefined)
    return null
  return { name: action.name, at: action.at, endedAt: action.endedAt, command: fullInputOf(text, action) ?? action.detail ?? '' }
}

function roundBlock(view: SessionView, step: string, now: string): string {
  const elapsed = view.startedAt === null ? null : Math.max(0, Date.parse(now) - Date.parse(view.startedAt))
  const share = elapsed === null || view.expectedMs === null ? null : elapsed / view.expectedMs
  const phase = roundPhase(share)
  const label = phase === 'over' ? ROUND_LABELS.overTime : phase === 'none' ? ROUND_LABELS.elapsed : ROUND_LABELS.remaining
  const clock = elapsed === null ? '--:--.--' : view.expectedMs === null ? roundClock(elapsed) : phase === 'over' ? `+${roundClock(elapsed - view.expectedMs)}` : roundClock(view.expectedMs - elapsed)
  const style = share === null ? '' : ` style="--_round: ${roundColour(share)}; --_left: ${percent(Math.max(0, 1 - share))}"`
  const data = view.startedAt === null ? '' : ` data-round-start="${escaped(view.startedAt)}"${view.expectedMs === null ? '' : ` data-round-expected-ms="${view.expectedMs}"`}`
  const meta = [
    view.expectedMs === null ? NO_DATA : `round of ~${view.expectedMs / MINUTE_MS} min`,
    `started ${view.startedAt === null ? NONE : clockOf(view.startedAt)}`,
    PULSE_PART.exec(step)?.[0] ?? `pulse ${NONE}`,
  ].join(' · ')
  return `<div class="round" data-phase="${phase}"${data}${style}><div class="round-head"><span class="round-label">${label}</span><span class="round-clock">${clock}</span></div><span class="round-bar"></span><div class="round-meta">${escaped(meta)}</div></div>`
}

export function stateLine(step: string, over: boolean): string {
  if (over)
    return '<div class="svc-state" data-state="over">OVER BUDGET</div>'
  if (ACTING_PART.test(step))
    return '<div class="svc-state" data-state="acting">ACTING</div>'
  const cause = WAIT_CAUSE.exec(step)?.[1]
  return `<div class="svc-state" data-state="waiting">WAITING · ${escaped(cause === undefined ? 'CAUSE UNKNOWN' : cause.toUpperCase())}</div>`
}

function terminalBlock(terminal: Terminal | null, now: string): string {
  if (terminal === null)
    return '<div class="term" data-none><div class="term-cap">NO TRANSCRIPT READ</div><pre class="term-cmd">$ <span class="term-cursor"></span></pre></div>'
  const name = terminal.name.toUpperCase()
  const caption = terminal.endedAt === null ? `NOW · ${name} · ${minutesBetween(terminal.at, now)} MIN` : `LAST · ${name} · ENDED ${clockOf(terminal.endedAt)}`
  return `<div class="term"><div class="term-cap">${escaped(caption)}</div><pre class="term-cmd">$ ${escaped(terminal.command)}<span class="term-cursor"></span></pre></div>`
}

function lasting(ms: number): string {
  return ms < MINUTE_MS ? `${Math.round(ms / SECOND_MS)}s` : `${Math.round(ms / MINUTE_MS)} min`
}

function stepsLine(view: SessionView, role: string, now: string): string {
  if (role !== STEPPED_ROLE)
    return ''
  const passed = new Set(view.steps.map(step => step.step))
  const current = ROUND_STEPS.find(step => !passed.has(step)) ?? null
  const spent = view.steps.reduce((sum, step) => sum + step.seconds * SECOND_MS, 0)
  const since = view.startedAt === null ? null : Date.parse(now) - Date.parse(view.startedAt) - spent
  const items = ROUND_STEPS.map(step => `<li${passed.has(step) ? ' data-passed' : step === current ? ' data-current' : ''}>${step}</li>`).join('')
  const reading = current === null ? NONE : `${current} · ${since === null ? NONE : lasting(Math.max(0, since))}`
  return `<div class="round-steps"><ol>${items}</ol><span class="round-step-now">${escaped(reading)}</span></div>`
}

export function sessionCard(service: BusService, view: SessionView, parts: SessionCardParts): string {
  return [
    `<div class="svc bevel" data-role="${escaped(service.role)}"${parts.opener}>`,
    `<div class="svc-top"><span class="svc-kind">${escaped(service.role)}</span><span class="lore">Runner</span><span class="svc-target">${escaped(service.task)}</span>${parts.hint}</div>`,
    roundBlock(view, service.step, parts.now),
    stateLine(service.step, parts.over),
    terminalBlock(view.terminal, parts.now),
    parts.bars,
    parts.agents,
    stepsLine(view, service.role, parts.now),
    '</div>',
  ].join('')
}
