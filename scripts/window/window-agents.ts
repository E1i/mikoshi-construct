import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { WINDOW_WHO } from '../../src/card/parking.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { openBus } from '../core/db.js'
import { findTranscript, measuredSession, stoppedTasksOf } from '../ports/client/claude/adapter.js'
import { processGit } from '../ports/git.js'
import { cardTree } from '../ports/worktree-home.js'
import { SESSION_VARIABLE } from './window-requests.js'

export { stoppedTasksOf }

export const AGENTS_FILE = '.construct/window-agents.jsonl'

interface AgentLine {
  event: string
  id: string
  type: string | null
  session: string | null
  at: string | null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function agentLines(text: string): AgentLine[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Partial<Record<keyof AgentLine, unknown>> | null
      if (typeof entry?.event !== 'string' || typeof entry.id !== 'string')
        return []
      return [{ event: entry.event, id: entry.id, type: stringOrNull(entry.type), session: stringOrNull(entry.session), at: stringOrNull(entry.at) }]
    }
    catch {
      return []
    }
  })
}

const PLAIN_SESSION = /^[\w-]+$/

export function sessionTranscriptOf(home: string, session: string | undefined): string | null {
  if (session === undefined || !PLAIN_SESSION.test(session))
    return null
  try {
    return findTranscript(home, session)
  }
  catch {
    return null
  }
}

export function stoppedTasksIn(transcript: string | null): Set<string> {
  if (transcript === null)
    return new Set()
  try {
    return stoppedTasksOf(readFileSync(transcript, 'utf8'))
  }
  catch {
    return new Set()
  }
}

export function agentsFileText(root: string): string {
  try {
    return readFileSync(path.join(root, AGENTS_FILE), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return ''
    throw error
  }
}

export const CRAWLER_STATES = { crawling: 'CRAWLING', idle: 'IDLE' } as const

export type CrawlerState = typeof CRAWLER_STATES[keyof typeof CRAWLER_STATES]

export interface WindowCrawler {
  id: string
  kind: string
  description: string | null
  started_at: string | null
  state: CrawlerState
  ctx: number | null
  spent: number | null
}

export interface WindowPresence {
  crawlers: WindowCrawler[]
  skills: string[]
}

interface TranscriptLine {
  type?: unknown
  message?: { role?: unknown, content?: unknown, stop_reason?: unknown }
}

interface ContentBlock {
  type?: unknown
  name?: unknown
  input?: Record<string, unknown>
}

const AGENT_FILE_PREFIX = 'agent-'
const SKILL_TOOL = 'Skill'
const SKILL_FIELDS = ['skill', 'command', 'name'] as const
const TURN_TYPES = new Set(['user', 'assistant'])
const TOOL_USE = 'tool_use'

function transcriptLinesOf(text: string): TranscriptLine[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as unknown
      return entry !== null && typeof entry === 'object' ? [entry as TranscriptLine] : []
    }
    catch {
      return []
    }
  })
}

function blocksOf(line: TranscriptLine): ContentBlock[] {
  const content = line.message?.content
  return Array.isArray(content) ? (content as unknown[]).filter((block): block is ContentBlock => block !== null && typeof block === 'object') : []
}

export function crawlerStateOf(text: string): CrawlerState {
  const last = transcriptLinesOf(text).filter(line => TURN_TYPES.has(String(line.type))).at(-1)
  const turnClosed = last?.type === 'assistant' && !blocksOf(last).some(block => block.type === TOOL_USE) && last.message?.stop_reason !== TOOL_USE
  return turnClosed ? CRAWLER_STATES.idle : CRAWLER_STATES.crawling
}

export function skillsOf(text: string): string[] {
  const names = transcriptLinesOf(text).flatMap(line => blocksOf(line).filter(block => block.type === TOOL_USE && block.name === SKILL_TOOL).flatMap((block) => {
    const name = SKILL_FIELDS.map(field => block.input?.[field]).find(value => typeof value === 'string' && value.trim() !== '')
    return typeof name === 'string' ? [name.trim()] : []
  }))
  return [...new Set(names)]
}

export function liveAgentStarts(text: string, session: string): Map<string, { type: string | null, at: string | null }> {
  const live = new Map<string, { type: string | null, at: string | null }>()
  for (const line of agentLines(text)) {
    if (line.session !== session)
      continue
    if (line.event === 'start')
      live.set(line.id, { type: line.type, at: line.at })
    else if (line.event === 'stop')
      live.delete(line.id)
  }
  return live
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
}

function metaOf(file: string): { agentType: string | null, description: string | null } {
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')) as { agentType?: unknown, description?: unknown } | null
    const textOf = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    return { agentType: textOf(meta?.agentType), description: textOf(meta?.description) }
  }
  catch {
    return { agentType: null, description: null }
  }
}

function usageOf(root: string, file: string): { ctx: number | null, spent: number | null } {
  try {
    const measured = measuredSession(root, file)
    return { ctx: measured.context, spent: measured.spent }
  }
  catch {
    return { ctx: null, spent: null }
  }
}

function subagentsDirOf(transcript: string): string {
  return path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
}

export function windowCrawlersOf(root: string, transcript: string, agentsText: string, session: string): WindowCrawler[] {
  const stopped = stoppedTasksIn(transcript)
  const dir = subagentsDirOf(transcript)
  return [...liveAgentStarts(agentsText, session)].filter(([id]) => !stopped.has(id)).map(([id, start]) => {
    const base = path.join(dir, id.startsWith(AGENT_FILE_PREFIX) ? id : `${AGENT_FILE_PREFIX}${id}`)
    const meta = metaOf(`${base}.meta.json`)
    const text = readOrNull(`${base}.jsonl`)
    const usage = text === null ? { ctx: null, spent: null } : usageOf(root, `${base}.jsonl`)
    return { id, kind: meta.agentType ?? start.type ?? id, description: meta.description, started_at: start.at, state: text === null ? CRAWLER_STATES.crawling : crawlerStateOf(text), ...usage }
  })
}

export function windowPresenceOf(home: string, root: string, session: string): WindowPresence {
  const transcript = sessionTranscriptOf(home, session)
  if (transcript === null)
    return { crawlers: [], skills: [] }
  const text = readOrNull(transcript)
  return { crawlers: windowCrawlersOf(root, transcript, agentsFileText(root), session), skills: text === null ? [] : skillsOf(text) }
}

export function liveAgentsOf(root: string, env: NodeJS.ProcessEnv = process.env, stopped: Set<string> = new Set()): string[] {
  const session = env[SESSION_VARIABLE]
  let text: string
  try {
    text = readFileSync(path.join(root, AGENTS_FILE), 'utf8')
  }
  catch {
    return []
  }
  const live = new Map<string, string>()
  for (const { event, id, type, session: lineSession } of agentLines(text)) {
    if (session === undefined || session === '' || lineSession !== session)
      continue
    if (event === 'start')
      live.set(id, type ?? id)
    else if (event === 'stop')
      live.delete(id)
  }
  return [...live].filter(([id]) => !stopped.has(id)).map(([, name]) => name)
}

function dirtinessOf(tree: string): string | null {
  try {
    const status = processGit.read(tree, ['status', '--porcelain'])
    return status.trim() === '' ? null : tree
  }
  catch {
    return `${tree} (unreadable: git status failed)`
  }
}

export function openCardTreesOf(db: DatabaseSync, env: NodeJS.ProcessEnv, busPath: string): string[] {
  const rows = db.prepare('SELECT cards.card_id FROM cards JOIN card_bodies AS body ON body.card_id = cards.card_id WHERE body.who = ? AND cards.state IS NOT NULL AND cards.state NOT IN (?, ?, ?)').all(WINDOW_WHO, MERGED_CARD, CLOSED_CARD, DROPPED_CARD) as { card_id: number }[]
  return rows.map(row => cardTree(env, busPath, String(row.card_id))).filter(tree => existsSync(tree))
}

export function dirtyTreesOf(trees: string[]): string[] {
  return trees.flatMap((tree) => {
    const dirty = dirtinessOf(tree)
    return dirty === null ? [] : [dirty]
  })
}

export function dirtyOpenCardTrees(env: NodeJS.ProcessEnv, busPath: string): string[] {
  const db = openBus(busPath)
  try {
    return dirtyTreesOf(openCardTreesOf(db, env, busPath))
  }
  finally {
    db.close()
  }
}
