import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { GHOST_JOURNAL } from './places.js'

export const PREFIX = '[answer:record] '
export const USAGE = 'usage: pnpm answer:record <card> <answer-<card>*.md>'
export const BRIEF_EVENT = 'answer-brief'

export interface AnswerRecordDeps {
  cwd: string
  handoffDir: string
  exists: (file: string) => boolean
  read: (file: string) => string
  realpath: (file: string) => string
  append: (file: string, text: string) => void
  now: () => Date
  out: (line: string) => void
  err: (line: string) => void
}

function isAnswerBrief(file: string, task: string): boolean {
  return new RegExp(`^answer-${task}(?:\\D[^/]*)?\\.md$`).test(path.basename(file))
}

export function runAnswerRecord(argv: string[], deps: AnswerRecordDeps): number {
  const [card, file, ...rest] = argv
  const task = card?.replace(/^#/, '')
  if (task === undefined || !/^\d+$/.test(task) || file === undefined || file.startsWith('-') || rest.length > 0) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const brief = path.resolve(deps.cwd, file)
  if (!deps.exists(brief)) {
    deps.err(`${PREFIX}the answer brief ${brief} does not exist; nothing written`)
    return 1
  }
  const real = deps.realpath(brief)
  if (!isAnswerBrief(brief, task) || !isAnswerBrief(real, task)) {
    deps.err(`${PREFIX}${brief} is not an answer-${task}*.md; nothing written`)
    return 1
  }
  const sha256 = createHash('sha256').update(deps.read(real)).digest('hex')
  const journal = path.join(deps.handoffDir, GHOST_JOURNAL)
  deps.append(journal, `${JSON.stringify({ event: BRIEF_EVENT, task, file: real, sha256, ts: deps.now().toISOString() })}\n`)
  deps.out(`${PREFIX}#${task} ${real} sha256 ${sha256} → ${journal}`)
  return 0
}

function realDeps(): AnswerRecordDeps {
  return {
    cwd: process.cwd(),
    handoffDir: process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    realpath: realpathSync,
    append: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, text)
    },
    now: () => new Date(),
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runAnswerRecord(process.argv.slice(2), realDeps())
