import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { openBus } from '../core/db.js'
import { cardTree } from '../ports/worktree-home.js'

export const AGENTS_FILE = '.construct/window-agents.jsonl'

interface AgentLine {
  event: string
  type: string
}

function agentLines(text: string): AgentLine[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Partial<AgentLine> | null
      return typeof entry?.event === 'string' && typeof entry.type === 'string' ? [{ event: entry.event, type: entry.type }] : []
    }
    catch {
      return []
    }
  })
}

export function liveAgentsOf(root: string): string[] {
  let text: string
  try {
    text = readFileSync(path.join(root, AGENTS_FILE), 'utf8')
  }
  catch {
    return []
  }
  const live: string[] = []
  for (const { event, type } of agentLines(text)) {
    if (event === 'start') {
      live.push(type)
    }
    else if (event === 'stop') {
      const at = live.indexOf(type)
      if (at !== -1)
        live.splice(at, 1)
    }
  }
  return live
}

function git(tree: string, args: string[]): string {
  return execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8' })
}

export function openCardTreesOf(db: DatabaseSync, env: NodeJS.ProcessEnv, busPath: string): string[] {
  const rows = db.prepare('SELECT card_id FROM cards WHERE state IS NOT NULL AND state NOT IN (?, ?, ?)').all(MERGED_CARD, CLOSED_CARD, DROPPED_CARD) as { card_id: number }[]
  return rows.map(row => cardTree(env, busPath, String(row.card_id))).filter(tree => existsSync(tree))
}

export function dirtyTreesOf(trees: string[]): string[] {
  return trees.filter(tree => git(tree, ['status', '--porcelain']).trim() !== '')
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
