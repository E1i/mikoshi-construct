import type { DatabaseSync } from 'node:sqlite'
import type { GitHub, StoredEvent } from './requests/reach.js'
import type { RequestOutcome, RequestPayload, RequestTools } from './requests/request.js'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BUS_REQUEST_COMMAND } from '../core/owner-commands.js'
import { RequestContext } from './requests/context.js'
import { dispatchRequest } from './requests/index.js'
import { ANSWER_SOURCE, appendEvent, cardIdOf, clientAdapter, CLOSED_WAIT, declaredPayload, defaultBusPath, FACTORY_MODES, ghApi, inTransaction, isFactoryMode, isFullSha, isOwnerMoveRequest, isOwnerWaitNeed, listFlagOf, openBus, openOwnerWait, OWNER_WAIT_CLOSED, OWNER_WAIT_NEEDS, OWNER_WAIT_OPENED, OWNER_WAITS, ownerChannelOf, ownerMoveRequestOf, ownerMoveUsage, parseTaken, POLICY_DENIED, prOf, QUEUE_ACTOR, readReleaseVersion, REQUEST_DONE, REQUEST_REFUSED, storedByKey, WINDOW_REQUEST } from './requests/reach.js'
import { foreignIdsOf, HEAD_WORD, isRequestKind, OWNER_ANSWER_USAGE, PLAN_OPS, REQUEST_KINDS, text } from './requests/request.js'

export { SESSION_VARIABLE } from '../ports/client/claude/adapter.js'
export { ALLOW_MERGE_RECORD, allowMergeRuleInForce } from './requests/allow-merge.js'
export { ANSWER_SOURCE } from './requests/reach.js'
export { HEAD_WORD, isRequestKind, OWNER_WORD_NEEDED, PLAN_OPS, REQUEST_KINDS, TAKEOVER_AFTER_MINUTES } from './requests/request.js'
export type { CardTask, Executed, RequestKind, RequestOutcome, RequestTools } from './requests/request.js'

const AMEND_WITNESS_SEPARATOR = '\n'
const PLAN_FLAGS = ['op', 'plan', 'title', 'goal', 'file', 'gate', 'card'] as const
const DECISION_FLAGS: ReadonlyMap<string, string> = new Map([['--card', 'cards'], ['--supersedes', 'supersedes'], ['--until', 'until'], ['--from', 'from']])
export const WINDOW_ACTOR = 'worker:window:'
export const REQUEST_RULE = 'window_request'
export const PREFIX = '[bus:request] '
export const USAGE = `usage: ${BUS_REQUEST_COMMAND} tree.cut --card <N> | amend --card <N> [--touches +<path>,-<path>] [--add-witness <witness>]... [--remove-witness <witness>]... [--owner-words <the owner's words>] [--depends +#<N>,-#<N>] [--priority p0|p1|p2|none] [--auto-confirm] | allow-merge --pr <N> --head <sha>|${HEAD_WORD} --dry-run <reviewer session> | close-pr|reopen-pr --pr <N> --card <N> --reason <text> | pr.body --pr <N> [--file <absolute path in the card tree>] | ci.rerun --pr <N> | requeue --task <task_key> [--keep-tree] | mode --set ${FACTORY_MODES.join('|')} | plan --op ${[...PLAN_OPS.keys()].join('|')} [--plan <id>] [--title <text>] [--goal <text>] [--file <absolute plan file>] [--gate <word>] [--card <N>] | owner.wait --need ${OWNER_WAIT_NEEDS.join('|')} --text <what the owner decides> [--command <line>] [--card <N>] [--pr <N>] | owner.wait.close --id Q<N> --answer <answer> [--from ${ANSWER_SOURCE}] | owner.wait.close --id Q<N> --from ${ANSWER_SOURCE} | decisions:add --from ${ANSWER_SOURCE} [--supersedes D-M]... [--card #N]... [--until <YYYY-MM-DDTHH:MMZ>] "[owner] <decision>" | hold --card <N> --reason <why the owner holds it> | release --card <N> | takeover --card <N> --reason <why the bus has no route for it> | drop --card <N> --reason <why a card with no body is dropped> | numbers.foreign --ids <card ids of another factory's row, comma separated> | ${ownerMoveUsage()}`

const BY_HAND = 'by-hand'
const HELP_FLAGS = ['--help', '-h']

const PENDING = `
  SELECT id, ts, type, actor, card_id, pr, head, dedupe_key, payload FROM events AS request
  WHERE request.type = '${WINDOW_REQUEST}' AND request.legacy = 0
    AND NOT EXISTS (SELECT 1 FROM events AS answer WHERE answer.dedupe_key = '${WINDOW_REQUEST}:' || request.id || ':answered')
  ORDER BY request.id
`

const UNCLOSED_QUESTION = `
  SELECT json_extract(opened.payload, '$.id') AS id FROM events AS opened
  WHERE opened.type = '${OWNER_WAIT_OPENED}' AND opened.legacy = 0
    AND json_extract(opened.payload, '$.need') = 'decision' AND json_extract(opened.payload, '$.text') = ?
    AND NOT EXISTS (SELECT 1 FROM ${OWNER_WAITS} AS wait WHERE wait.id = json_extract(opened.payload, '$.id') AND wait.state = '${CLOSED_WAIT}')
    AND NOT EXISTS (SELECT 1 FROM events AS closed WHERE closed.type = '${OWNER_WAIT_CLOSED}' AND json_extract(closed.payload, '$.id') = json_extract(opened.payload, '$.id'))
  ORDER BY opened.id LIMIT 1
`

export function requestFromWindow(db: DatabaseSync, ts: string, session: string, request: RequestPayload): number {
  const dedupeKey = `${WINDOW_REQUEST}:${session}:${ts}:${randomUUID()}`
  const cardId = cardIdOf(request.card)
  const pr = prOf(request.pr)
  const head = isFullSha(request.head) ? request.head : null
  appendEvent(db, { ts, type: WINDOW_REQUEST, actor: `${WINDOW_ACTOR}${session}`, cardId, pr, head, dedupeKey, payload: declaredPayload(WINDOW_REQUEST, request), legacy: false })
  return storedByKey(db, dedupeKey).id
}

export function openWindowQuestion(db: DatabaseSync, ts: string, session: string, question: string): string {
  return inTransaction(db, () => {
    const open = db.prepare(UNCLOSED_QUESTION).get(question) as { id: string } | undefined
    if (open !== undefined)
      return open.id
    const request = requestFromWindow(db, ts, session, { kind: 'owner.wait', need: 'decision', text: question })
    const id = openOwnerWait(db, ts, QUEUE_ACTOR, { need: 'decision', text: question, request })
    appendEvent(db, { ts, type: REQUEST_DONE, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_REQUEST}:${request}:answered`, payload: { request, kind: 'owner.wait', detail: `opened ${id}` }, legacy: false })
    return id
  })
}

export function pendingRequests(db: DatabaseSync): StoredEvent[] {
  return db.prepare(PENDING).all() as unknown as StoredEvent[]
}

export class WindowRequests {
  private readonly context: RequestContext

  constructor(private readonly db: DatabaseSync, clock: () => Date, private readonly tools: RequestTools, ownerChannel: string = ownerChannelOf(os.homedir()), releaseVersion: () => string | null = () => readReleaseVersion(), repository: string = process.cwd(), gitHub: GitHub = ghApi(repository)) {
    this.context = new RequestContext(db, clock, tools, ownerChannel, releaseVersion, repository, gitHub)
  }

  run(): RequestOutcome[] {
    const answered = pendingRequests(this.db).map(request => this.answer(request))
    this.tools.closeDropped()
    this.tools.settleDecisions?.()
    return answered
  }

  private answer(request: StoredEvent): RequestOutcome {
    const payload = JSON.parse(request.payload) as RequestPayload
    const outcome = this.execute(request.id, payload)
    const ts = this.context.now()
    inTransaction(this.db, () => {
      const type = outcome.kind === 'done' ? REQUEST_DONE : REQUEST_REFUSED
      appendEvent(this.db, { ts, type, actor: QUEUE_ACTOR, cardId: request.card_id, pr: request.pr, head: request.head, dedupeKey: `${WINDOW_REQUEST}:${request.id}:answered`, payload: { request: request.id, kind: payload.kind ?? null, detail: outcome.detail, ...(outcome.kind === 'owner' ? { owner: true } : {}) }, legacy: false })
      if (outcome.kind === 'owner')
        appendEvent(this.db, { ts, type: POLICY_DENIED, actor: QUEUE_ACTOR, cardId: request.card_id, pr: request.pr, head: request.head, dedupeKey: `${POLICY_DENIED}:${WINDOW_REQUEST}:${request.id}`, payload: { kind: 'authority', rule: REQUEST_RULE, command: `${WINDOW_REQUEST} ${String(payload.kind)}`, detail: outcome.detail }, legacy: false })
    })
    return outcome
  }

  private execute(request: number, payload: RequestPayload): RequestOutcome {
    const kind = payload.kind
    if (!isRequestKind(kind))
      return { kind: 'owner', request, detail: `the window asked for ${JSON.stringify(kind ?? null)}, not one of ${REQUEST_KINDS.join(', ')}; refused, the owner decides` }
    const executed = dispatchRequest(this.context, kind, request, payload)
    return { kind: executed.done ? 'done' : 'refused', request, detail: executed.why }
  }
}

function decisionRequestOf(argv: readonly string[]): RequestPayload | null {
  const fields: Record<string, string[]> = { cards: [], supersedes: [], until: [], from: [] }
  const texts: string[] = []
  for (let at = 1; at < argv.length; at += 1) {
    const field = DECISION_FLAGS.get(argv[at]!)
    if (field !== undefined && argv[at + 1] !== undefined) {
      fields[field]!.push(argv[at + 1]!)
      at += 1
    }
    else if (argv[at]!.startsWith('--')) {
      return null
    }
    else {
      texts.push(argv[at]!)
    }
  }
  const { cards, supersedes, until, from } = fields
  if (texts.length !== 1 || from!.length !== 1 || until!.length > 1)
    return null
  return { kind: 'decisions:add', text: texts[0], from: from![0], cards, supersedes, ...(until!.length === 0 ? {} : { until: until![0] }) }
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

function amendRequestOf(argv: readonly string[]): RequestPayload | null {
  const card = cardIdOf(flag(argv, '--card'))
  if (card === null)
    return null
  const addWitnesses = listFlagOf(argv, 'add-witness', AMEND_WITNESS_SEPARATOR)?.split(AMEND_WITNESS_SEPARATOR)
  const removeWitnesses = listFlagOf(argv, 'remove-witness', AMEND_WITNESS_SEPARATOR)?.split(AMEND_WITNESS_SEPARATOR)
  const fields = { touches: listFlagOf(argv, 'touches'), depends: listFlagOf(argv, 'depends'), add_witness: addWitnesses, remove_witness: removeWitnesses, owner_words: flag(argv, '--owner-words'), priority: flag(argv, '--priority') }
  return { kind: 'amend', card, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), ...(argv.includes('--auto-confirm') ? { auto_confirm: true } : {}) }
}

export function requestOf(argv: readonly string[]): RequestPayload | null {
  const kind = argv[0]
  if (kind === undefined || kind.startsWith('--'))
    return null
  if (kind === 'tree.cut') {
    const card = cardIdOf(flag(argv, '--card'))
    return card === null ? null : { kind, card }
  }
  if (kind === 'amend')
    return amendRequestOf(argv)
  if (kind === 'allow-merge') {
    const [pr, head, dryRun] = [prOf(Number(flag(argv, '--pr'))), flag(argv, '--head'), flag(argv, '--dry-run')]
    return pr === null || (head !== HEAD_WORD && !isFullSha(head)) || dryRun === undefined ? null : { kind, pr, head, dry_run: dryRun }
  }
  if (kind === 'close-pr' || kind === 'reopen-pr') {
    const [pr, card, reason] = [prOf(Number(flag(argv, '--pr'))), cardIdOf(flag(argv, '--card')), flag(argv, '--reason')]
    return pr === null || card === null || reason === undefined ? null : { kind, pr, card, reason }
  }
  if (kind === 'order.move') {
    const [pr, before] = [prOf(Number(flag(argv, '--pr'))), flag(argv, '--before')]
    return pr === null ? null : { kind, pr, ...(before === undefined ? {} : { before: Number(before) }) }
  }
  if (kind === 'pr.body' || kind === 'ci.rerun') {
    const [pr, file] = [prOf(Number(flag(argv, '--pr'))), kind === 'pr.body' ? flag(argv, '--file') : undefined]
    return pr === null ? null : { kind, pr, ...(file === undefined ? {} : { file }) }
  }
  if (kind === 'requeue') {
    const task = flag(argv, '--task')
    return task === undefined ? null : { kind, task_key: task, ...(argv.includes('--keep-tree') ? { keep_tree: true } : {}) }
  }
  if (kind === 'mode')
    return isFactoryMode(flag(argv, '--set')) ? { kind, mode: flag(argv, '--set') } : null
  if (kind === 'owner.wait') {
    const need = flag(argv, '--need')
    const waitText = flag(argv, '--text')
    const fields = { command: flag(argv, '--command'), card: cardIdOf(flag(argv, '--card')) ?? undefined, pr: prOf(Number(flag(argv, '--pr'))) ?? undefined }
    return !isOwnerWaitNeed(need) || waitText === undefined ? null : { kind, need, text: waitText, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) }
  }
  if (kind === 'owner.wait.close') {
    const id = flag(argv, '--id')
    const answer = flag(argv, '--answer')
    const from = flag(argv, '--from')
    return id === undefined || (answer === undefined && from === undefined) ? null : { kind, id, ...(answer === undefined ? {} : { answer }), ...(from === undefined ? {} : { from }) }
  }
  if (kind === 'decisions:add')
    return decisionRequestOf(argv)
  if (kind === 'hold' || kind === 'release') {
    const card = cardIdOf(flag(argv, '--card'))
    const reason = flag(argv, '--reason')
    if (card === null || (kind === 'hold' && reason === undefined))
      return null
    return { kind, card, ...(reason === undefined ? {} : { reason }) }
  }
  if (kind === 'takeover' || kind === 'drop') {
    const card = cardIdOf(flag(argv, '--card'))
    const reason = flag(argv, '--reason')
    return card === null || reason === undefined ? null : { kind, card, reason }
  }
  if (kind === 'numbers.foreign') {
    const listed = parseTaken(flag(argv, '--ids') ?? '')
    const ids = listed.kind === 'taken' ? foreignIdsOf(listed.numbers) : null
    return ids === null ? null : { kind, ids }
  }
  if (kind === 'plan') {
    const given = PLAN_FLAGS.flatMap(name => flag(argv, `--${name}`) === undefined ? [] : [[name, flag(argv, `--${name}`)] as const])
    return { kind, ...Object.fromEntries(given) }
  }
  return isOwnerMoveRequest(kind) ? ownerMoveRequestOf(kind, argv) : { kind }
}

function printUsage(out: (line: string) => void): void {
  out(`${PREFIX}${USAGE}`)
  out(`${PREFIX}${OWNER_ANSWER_USAGE}`)
}

export function runRequest(argv: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void): number {
  const request = requestOf(argv)
  if (request === null) {
    printUsage(out)
    return 2
  }
  const id = requestFromWindow(db, now.toISOString(), session, request)
  out(`${PREFIX}${WINDOW_REQUEST} ${id} (${String(request.kind)}) written; bus:run answers it with ${REQUEST_DONE} or ${REQUEST_REFUSED} on its next tick`)
  return 0
}

export function requestSession(env: NodeJS.ProcessEnv): string {
  return text(clientAdapter().ownSession(env)) ?? BY_HAND
}

export function requestActor(env: NodeJS.ProcessEnv): string {
  return `${WINDOW_ACTOR}${requestSession(env)}`
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv.some(argument => HELP_FLAGS.includes(argument))) {
    printUsage(line => console.log(line))
  }
  else {
    const db = openBus(defaultBusPath())
    try {
      process.exitCode = runRequest(argv, db, new Date(), requestSession(process.env), line => console.log(line))
    }
    finally {
      db.close()
    }
  }
}
