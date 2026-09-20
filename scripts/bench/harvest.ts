import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { usability } from './usable.js'

const PROJECTS = path.join(homedir(), '.claude', 'projects')
const TOOL = 'StructuredOutput'

export interface Attempt {
  attempt: number
  outcome: 'unparsable' | 'empty' | 'accepted'
  journaledChars: number
  usable: boolean | null
  shortfalls: string[]
  stopReason: string | null
  outputTokens: number | null
}

export interface Entry {
  label: string
  agent: string
  attempts: Attempt[]
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function completionOf(rows: Array<Record<string, unknown>>, requestId: unknown): Record<string, unknown> {
  const settled = rows.filter(row => row.requestId === requestId
    && ((row.message as Record<string, unknown> | undefined)?.stop_reason) != null)
  return (settled.at(-1)?.message as Record<string, unknown>) ?? {}
}

function attemptsIn(rows: Array<Record<string, unknown>>): Attempt[] {
  const attempts: Attempt[] = []
  for (const row of rows) {
    const message = row.message as { content?: unknown } | undefined
    if (!Array.isArray(message?.content))
      continue
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_use' || block.name !== TOOL)
        continue
      const input = (block.input ?? {}) as Record<string, unknown>
      const unparsed = input.__unparsedToolInput as { raw?: string } | undefined
      const completion = completionOf(rows, row.requestId)
      const usage = (completion.usage ?? {}) as { output_tokens?: number }
      const verdict = unparsed?.raw == null && Object.keys(input).length > 0 ? usability(input) : null
      attempts.push({
        attempt: attempts.length + 1,
        outcome: unparsed?.raw != null ? 'unparsable' : Object.keys(input).length === 0 ? 'empty' : 'accepted',
        journaledChars: unparsed?.raw?.length ?? JSON.stringify(input).length,
        usable: verdict?.usable ?? null,
        shortfalls: verdict?.shortfalls ?? [],
        stopReason: (completion.stop_reason as string | null) ?? null,
        outputTokens: usage.output_tokens ?? null,
      })
    }
  }
  return attempts
}

export function harvest(runId: string): Entry[] {
  const found = readdirSync(PROJECTS)
    .flatMap((project) => {
      const sessions = path.join(PROJECTS, project)
      return statSync(sessions).isDirectory()
        ? readdirSync(sessions).map(session => path.join(sessions, session, 'subagents', 'workflows', runId))
        : []
    })
    .find((candidate) => {
      try {
        return statSync(candidate).isDirectory()
      }
      catch {
        return false
      }
    })
  if (found == null)
    throw new Error(`no journal directory for ${runId}`)

  return readdirSync(found)
    .filter(entry => entry.endsWith('.meta.json'))
    .sort()
    .map((entry) => {
      const agent = entry.replace('.meta.json', '').replace('agent-', '')
      const meta = JSON.parse(readFileSync(path.join(found, entry), 'utf8'))
      return {
        label: String(meta.description ?? agent),
        agent,
        attempts: attemptsIn(lines(path.join(found, `agent-${agent}.jsonl`))),
      }
    })
}

if (process.argv[1]?.endsWith('harvest.ts')) {
  const runId = process.argv[2]
  if (runId == null)
    throw new Error('name the workflow run to harvest')
  for (const entry of harvest(runId)) {
    console.log(`\n${entry.label} (${entry.agent})`)
    console.log('  attempt  outcome      chars  stop        tokens  usable  shortfall')
    for (const attempt of entry.attempts) {
      const usable = attempt.usable == null ? '—' : attempt.usable ? 'yes' : 'NO'
      console.log(`  ${String(attempt.attempt).padEnd(9)}${attempt.outcome.padEnd(13)}${String(attempt.journaledChars).padStart(5)}  ${(attempt.stopReason ?? '—').padEnd(12)}${String(attempt.outputTokens ?? '—').padStart(6)}  ${usable.padEnd(7)} ${attempt.shortfalls[0] ?? ''}`)
    }
  }
}
