import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { WINDOW_WHO } from '../../src/card/parking.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { openBus } from '../core/db.js'
import { cardTree } from '../ports/worktree-home.js'
import { SESSION_VARIABLE } from './window-requests.js'

export const AGENTS_FILE = '.construct/window-agents.jsonl'

interface AgentLine {
  event: string
  id: string
  type: string | null
  session: string | null
}

function agentLines(text: string): AgentLine[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Partial<AgentLine> | null
      if (typeof entry?.event !== 'string' || typeof entry.id !== 'string')
        return []
      return [{ event: entry.event, id: entry.id, type: typeof entry.type === 'string' ? entry.type : null, session: typeof entry.session === 'string' ? entry.session : null }]
    }
    catch {
      return []
    }
  })
}

export function liveAgentsOf(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
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
  return [...live.values()]
}

function dirtinessOf(tree: string): string | null {
  try {
    const status = execFileSync('git', ['-C', tree, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
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
