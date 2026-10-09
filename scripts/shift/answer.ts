import type { Card } from '../../src/card/grammar.js'
import type { ClaudeExit, ClaudeRun } from './claude.js'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { startedTree } from '../ghosts/tasks.js'
import { CLAUDE_VARIABLE } from './claude.js'
import { GHOST_JOURNAL } from './places.js'

export const PREFIX = '[shift:answer] '
export const ANSWER_FLAG = '--answer'
export const PROMPT_FLAG = '--prompt'
export const ANSWER_COMMAND = `pnpm shift <dir> ${ANSWER_FLAG} <task> ${PROMPT_FLAG} <dir>/answer-<task>*.md`
export const USAGE = `usage: ${ANSWER_COMMAND}`
const BRIEF_EVENT = 'answer-brief'

export interface AnswerDeps {
  cwd: string
  claude: string | undefined
  handoffDir: string
  read: (file: string) => string
  exists: (target: string) => boolean
  append: (file: string, text: string) => void
  write: (file: string, text: string) => void
  now: () => Date
  uuid: () => string
  run: (run: ClaudeRun) => Promise<ClaudeExit>
  out: (line: string) => void
  err: (line: string) => void
}

export function answerPidPath(dir: string, task: string): string {
  return path.join(dir, `answer-${task}.pid`)
}

export function answerLogPath(dir: string, task: string): string {
  return path.join(dir, `log-${task}-answer.txt`)
}

function isAnswerBrief(file: string, task: string): boolean {
  return new RegExp(`^answer-${task}(?:\\D[^/]*)?\\.md$`).test(path.basename(file))
}

function journaledSha256(journal: string, task: string, files: string[]): string | undefined {
  return journal.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { event?: unknown, task?: unknown, file?: unknown, sha256?: unknown }
      return entry.event === BRIEF_EVENT && entry.task === task && typeof entry.file === 'string' && files.includes(path.resolve(entry.file)) && typeof entry.sha256 === 'string' ? [entry.sha256] : []
    }
    catch {
      return []
    }
  }).at(-1)
}

function parse(argv: string[]): { dir: string, task: string, prompt: string } | null {
  const taskAt = argv.indexOf(ANSWER_FLAG)
  const promptAt = argv.indexOf(PROMPT_FLAG)
  const task = argv[taskAt + 1]?.replace(/^#/, '')
  const prompt = promptAt === -1 ? undefined : argv[promptAt + 1]
  const rest = argv.filter((_, index) => ![taskAt, taskAt + 1, promptAt, promptAt + 1].includes(index))
  if (rest.length !== 1 || rest[0]!.startsWith('-') || task === undefined || !/^\d+$/.test(task) || prompt === undefined || prompt.startsWith('-'))
    return null
  return { dir: rest[0]!, task, prompt }
}

function note(deps: AnswerDeps, task: string, text: string): void {
  deps.append(path.join(deps.handoffDir, GHOST_JOURNAL), `${JSON.stringify({ event: 'note', task, at: deps.now().toISOString(), note: text })}\n`)
}

function refuse(deps: AnswerDeps, line: string): number {
  deps.err(`${PREFIX}${line}; nothing started`)
  return 1
}

export async function runAnswer(argv: string[], deps: AnswerDeps): Promise<number> {
  const parsed = parse(argv)
  if (parsed === null) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const { task } = parsed
  const dir = path.resolve(deps.cwd, parsed.dir)
  const prompt = path.resolve(deps.cwd, parsed.prompt)
  if (!deps.exists(prompt))
    return refuse(deps, `the prompt file ${prompt} does not exist`)
  const realPrompt = realpathSync(prompt)
  if (!deps.exists(dir) || path.dirname(realPrompt) !== realpathSync(dir) || !isAnswerBrief(realPrompt, task))
    return refuse(deps, `the prompt file ${prompt} is not an answer-${task}*.md inside the shift directory ${dir}`)
  const journal = path.join(deps.handoffDir, GHOST_JOURNAL)
  const journalText = deps.exists(journal) ? deps.read(journal) : ''
  const started = startedTree(journalText, { id: Number(task) } as Card)
  if (started === undefined)
    return refuse(deps, `task #${task} has no task:start line in ${journal}`)
  const expected = journaledSha256(journalText, task, [prompt, realPrompt])
  if (expected === undefined)
    return refuse(deps, `no event:${BRIEF_EVENT} line for #${task} names ${prompt} in ${journal}`)
  const text = deps.read(prompt)
  const actual = createHash('sha256').update(text).digest('hex')
  if (actual !== expected)
    return refuse(deps, `the sha256 of ${prompt} is ${actual}, not the journaled ${expected}`)
  if (!deps.exists(started.worktree))
    return refuse(deps, `the tree ${started.worktree} of #${task} does not exist`)
  const claude = deps.claude?.trim() ?? ''
  if (claude === '')
    return refuse(deps, `${CLAUDE_VARIABLE} is not set; it names the claude command`)
  const session = deps.uuid()
  const pidFile = answerPidPath(dir, task)
  const log = answerLogPath(dir, task)
  const exit = await deps.run({
    command: claude,
    cwd: started.worktree,
    sessionId: session,
    card: Number(task),
    prompt: text,
    log,
    onSpawn: (pid) => {
      deps.write(pidFile, `${pid}\n`)
      note(deps, task, `answer session started: pid ${pid}, session ${session}, prompt ${prompt}, tree ${started.worktree}, log ${log}`)
      deps.out(`${PREFIX}#${task} session ${session} pid ${pid} · log ${log}`)
    },
  })
  const ended = exit.kind === 'unspawnable' ? `not spawned: ${exit.error}` : `exit ${exit.code ?? exit.signal}`
  note(deps, task, `answer session ended: ${ended}, session ${session}`)
  deps.out(`${PREFIX}#${task} session ${session} ${ended}`)
  return exit.kind === 'exited' && exit.code === 0 ? 0 : 1
}
