import type { DatabaseSync } from 'node:sqlite'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { CommandResult, GhResponse, GitHub, GitHubPut } from '../../ports/github.js'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { appendEvent } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED } from '../../core/events.js'
import { cardPrPolicy } from '../../policy/policy.js'
import { rerunFailedJobsEndpoint, runsOnHeadEndpoint } from '../../ports/ci-reading.js'
import { readPullOf } from './pr-close.js'

export const RERUN_COMMAND = 'rerun'
export const BODY_COMMAND = 'body'
const REPO = 'repos/{owner}/{repo}'
const RERUN_ACCEPTED = 201
const FIRST_ATTEMPT = 1
const FAILED = 'failure'

export interface ActionOutcome {
  done: boolean
  why: string
}

export interface CardPull {
  pr: number
  cardId: number
  head: string
  body: string
}

interface Written {
  result: CommandResult
  detail: string
  fields?: { runs: number[], run?: number }
}

type Prepared<W>
  = | { kind: 'denied', rule: string, detail: string }
    | { kind: 'failed', detail: string }
    | { kind: 'ready', write: W, detail: string }

interface WorkflowRun {
  id?: unknown
  conclusion?: unknown
  run_attempt?: unknown
}

export interface CardPrWriteParts {
  db: DatabaseSync
  gitHub: GitHub
  clock: () => Date
  pushPolicy?: () => PushPolicy
}

abstract class CardPrWrite<A, W> {
  protected abstract readonly command: string
  protected abstract readonly verb: string

  constructor(protected readonly parts: CardPrWriteParts) {}

  protected abstract prepare(pull: CardPull, asked: A): Prepared<W>
  protected abstract write(pull: CardPull, write: W): Written

  protected act(attempt: string, pr: number, asked: A): ActionOutcome {
    if (this.parts.pushPolicy?.() === 'none')
      return { done: false, why: `push policy none: the bus does not ${this.verb} PR #${pr}` }
    const read = readPullOf(this.parts.gitHub, pr)
    if (typeof read === 'string')
      return { done: false, why: read }
    const verdict = cardPrPolicy({ pr, state: String(read.state ?? ''), headRef: String(read.head?.ref ?? ''), body: String(read.body ?? '') })
    if (verdict.kind === 'denied')
      return this.denied(attempt, pr, null, verdict.rule, verdict.detail)
    const pull: CardPull = { pr, cardId: verdict.cardId, head: String(read.head?.sha ?? ''), body: String(read.body ?? '') }
    const prepared = this.prepared(pull, asked)
    if (prepared.kind === 'failed')
      return { done: false, why: prepared.detail }
    if (prepared.kind === 'denied')
      return this.denied(attempt, pr, pull.cardId, prepared.rule, prepared.detail)
    this.record(attempt, pr, pull.cardId, POLICY_ALLOWED, this.keyOf(POLICY_ALLOWED, attempt), { command: this.command, rule: verdict.rule, detail: prepared.detail })
    const written = this.written(pull, prepared.write)
    this.record(attempt, pr, pull.cardId, COMMAND_EXECUTED, this.keyOf(COMMAND_EXECUTED, attempt), { command: this.command, ...written.result, ...written.fields })
    return { done: written.result.ok, why: written.detail }
  }

  private prepared(pull: CardPull, asked: A): Prepared<W> {
    try {
      return this.prepare(pull, asked)
    }
    catch (error) {
      return { kind: 'failed', detail: `could not ${this.verb} PR #${pull.pr}: ${messageOf(error)}` }
    }
  }

  private written(pull: CardPull, write: W): Written {
    try {
      return this.write(pull, write)
    }
    catch (error) {
      return { result: { ok: false, error: messageOf(error) }, detail: `could not ${this.verb} PR #${pull.pr}: ${messageOf(error)}` }
    }
  }

  private denied(attempt: string, pr: number, cardId: number | null, rule: string, detail: string): ActionOutcome {
    this.record(attempt, pr, cardId, POLICY_DENIED, `${this.keyOf(POLICY_DENIED, attempt)}:${rule}`, { command: this.command, kind: 'authority', rule, detail })
    return { done: false, why: detail }
  }

  private keyOf(type: string, attempt: string): string {
    return `${type}:${this.command}:${attempt}`
  }

  private record(attempt: string, pr: number, cardId: number | null, type: string, dedupeKey: string, payload: Record<string, unknown>): void {
    const actor = type === COMMAND_EXECUTED ? `worker:${this.command}-pr:bus` : 'policy'
    appendEvent(this.parts.db, { ts: this.parts.clock().toISOString(), type, actor, cardId, pr, head: null, dedupeKey, payload: { ...payload, attempt }, legacy: false })
  }
}

function answerMessage(response: GhResponse): string {
  const message = (response.body as { message?: unknown } | null)?.message
  return typeof message === 'string' ? `: ${message}` : ''
}

export class CiRerunner extends CardPrWrite<null, number[]> {
  protected readonly command = RERUN_COMMAND
  protected readonly verb = 're-run the failed jobs of'

  constructor(parts: CardPrWriteParts, private readonly post: GitHubPut) {
    super(parts)
  }

  rerun(attempt: string, pr: number): ActionOutcome {
    return this.act(attempt, pr, null)
  }

  protected prepare(pull: CardPull): Prepared<number[]> {
    const response = this.parts.gitHub(runsOnHeadEndpoint(pull.head))
    if (response.status !== 200)
      return { kind: 'failed', detail: `GitHub answered ${response.status} to the read of the runs on ${pull.head}${answerMessage(response)}` }
    const runs = ((response.body as { workflow_runs?: WorkflowRun[] } | null)?.workflow_runs ?? []).filter(run => run.conclusion === FAILED)
    if (runs.length === 0)
      return { kind: 'denied', rule: 'no_failed_run', detail: `no run on the head ${pull.head} of PR #${pull.pr} failed, so nothing is re-run` }
    const rerun = runs.find(run => Number(run.run_attempt ?? FIRST_ATTEMPT) > FIRST_ATTEMPT)
    if (rerun !== undefined)
      return { kind: 'denied', rule: 'already_rerun', detail: `run ${String(rerun.id)} on the head ${pull.head} of PR #${pull.pr} is at attempt ${String(rerun.run_attempt)}; a second re-run is the owner's` }
    const ids = runs.map(run => Number(run.id))
    return { kind: 'ready', write: ids, detail: `the failed runs ${ids.join(', ')} on the head ${pull.head} of PR #${pull.pr}, each at its first attempt` }
  }

  protected write(pull: CardPull, ids: number[]): Written {
    for (const id of ids) {
      const response = this.post(rerunFailedJobsEndpoint(id), {})
      if (response.status !== RERUN_ACCEPTED)
        return { result: { ok: false, status: response.status }, fields: { runs: ids, run: id }, detail: `GitHub answered ${response.status} to the re-run of the failed jobs of run ${id} on PR #${pull.pr}${answerMessage(response)}` }
    }
    return { result: { ok: true, status: RERUN_ACCEPTED }, fields: { runs: ids }, detail: `re-ran the failed jobs of runs ${ids.join(', ')} on the head ${pull.head} of PR #${pull.pr}` }
  }
}

export class PrBodyFileAppender extends CardPrWrite<string, string> {
  protected readonly command = BODY_COMMAND
  protected readonly verb = 'change the body of'

  constructor(parts: CardPrWriteParts, private readonly patch: GitHubPut, private readonly treeOf: (cardId: number) => string) {
    super(parts)
  }

  append(attempt: string, pr: number, file: string): ActionOutcome {
    return this.act(attempt, pr, file)
  }

  protected prepare(pull: CardPull, file: string): Prepared<string> {
    const tree = this.treeOf(pull.cardId)
    if (!path.isAbsolute(file) || !existsSync(file) || !statSync(file).isFile() || !existsSync(tree) || !insideOf(realpathSync(tree), realpathSync(file)))
      return { kind: 'denied', rule: 'outside_tree', detail: `${file} is not a file in the tree ${tree} of card #${pull.cardId}` }
    const text = readFileSync(file, 'utf8').trim()
    if (text === '')
      return { kind: 'denied', rule: 'empty_file', detail: `${file} is empty, so nothing is appended to PR #${pull.pr}` }
    if (pull.body.includes(text))
      return { kind: 'denied', rule: 'already_held', detail: `the body of PR #${pull.pr} already holds the text of ${file}` }
    return { kind: 'ready', write: text, detail: `${file} is in the tree of card #${pull.cardId} and not yet in the body of PR #${pull.pr}` }
  }

  protected write(pull: CardPull, text: string): Written {
    const response = this.patch(`${REPO}/pulls/${pull.pr}`, { body: `${pull.body}\n\n${text}` })
    return response.status === 200
      ? { result: { ok: true, status: 200 }, detail: `appended the file to the body of PR #${pull.pr}` }
      : { result: { ok: false, status: response.status }, detail: `GitHub answered ${response.status} to the write of the body of PR #${pull.pr}${answerMessage(response)}` }
  }
}

function insideOf(tree: string, file: string): boolean {
  const relative = path.relative(tree, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
