import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CostReport } from './source.js'
import { labelledAgentTokens } from './claude-code.js'

export interface DaemonObjectCost {
  run: string
  object: string
  verdict: string
  agent: string | null
  tokens: number | null
}

export type DaemonCostReport = CostReport & { daemon?: DaemonObjectCost[] }

const DAEMON_HOME = path.join('.construct', 'daemon')
const EVIDENCE_FILE = 'evidence.json'

function directoriesIn(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : []
}

function evidenceIn(file: string): { verdict: string, agent: string | null } | null {
  if (!existsSync(file))
    return null
  try {
    const evidence = JSON.parse(readFileSync(file, 'utf8')) as { verdict?: unknown, agent?: unknown }
    return typeof evidence.verdict === 'string' ? { verdict: evidence.verdict, agent: typeof evidence.agent === 'string' ? evidence.agent : null } : null
  }
  catch {
    return null
  }
}

export function readDaemonObjects(cwd: string, projectsDir: string): DaemonObjectCost[] {
  const home = path.join(cwd, DAEMON_HOME)
  return directoriesIn(home).flatMap(run => directoriesIn(path.join(home, run)).flatMap((object) => {
    const evidence = evidenceIn(path.join(home, run, object, EVIDENCE_FILE))
    if (evidence == null)
      return []
    return [{ run, object, verdict: evidence.verdict, agent: evidence.agent, tokens: evidence.agent == null ? null : labelledAgentTokens(evidence.agent, projectsDir) }]
  }))
}
