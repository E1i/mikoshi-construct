import type { DatabaseSync } from 'node:sqlite'
import type { ProcessList, RunningProcess } from './bg.js'
import type { ActiveShard, Board, ComponentHealth, ContractLink, ExecutionRow, LaneRow, QueueCard, TaskQueue, Watched } from './board.js'
import { existsSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { answerLeaseOrder } from './answer-worker.js'
import { psList, RUN_SCRIPT, runningInstance } from './bg.js'
import { BOARD_FILE, readBoard } from './board.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from './db.js'
import { NODE_EQUIVALENCE } from './node.js'
import { openDatabase } from './sqlite.js'
import { SUPERVISOR_LAUNCH } from './supervisor.js'
import { switchedOn, workerLaunches, WORKERS } from './workers.js'

export const PREFIX = '[bus:board] '
export const REFRESH_SECONDS = 30

export interface BoardFiles {
  write: (file: string, text: string) => void
  rename: (from: string, to: string) => void
}

export const DISK_FILES: BoardFiles = {
  write: (file, text) => writeFileSync(file, text),
  rename: renameSync,
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

function escaped(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char]!)
}

function ago(at: string, ts: string | null): string {
  if (ts === null)
    return 'never'
  const minutes = Math.max(0, Math.round((Date.parse(at) - Date.parse(ts)) / 60_000))
  return `${minutes} min ago`
}

function table(head: readonly string[], rows: readonly (readonly string[])[], empty: string): string {
  if (rows.length === 0)
    return `<p data-empty>${escaped(empty)}</p>`
  const header = `<tr>${head.map(cell => `<th>${escaped(cell)}</th>`).join('')}</tr>`
  return `<table>${header}${rows.map(row => `<tr>${row.join('')}</tr>`).join('')}</table>`
}

function cell(text: string, tone?: string): string {
  return tone === undefined ? `<td>${escaped(text)}</td>` : `<td data-tone="${tone}">${escaped(text)}</td>`
}

function queueRows(cards: readonly QueueCard[]): string[][] {
  return cards.map(card => [cell(`#${card.card}`), cell(card.lane), cell(card.reason ?? '')])
}

function queueSection(board: Board): string {
  return [
    '<section><h2>Queue</h2>',
    '<h3>ready</h3>',
    table(['card', 'lane', ''], queueRows(board.ready), 'nothing ready'),
    '<h3>waiting</h3>',
    table(['card', 'lane', 'on'], queueRows(board.waiting), 'nothing waiting'),
    '<h3>blocked</h3>',
    table(['card', 'lane', 'by'], queueRows(board.blocked), 'nothing blocked'),
    '</section>',
  ].join('')
}

function healthTone(component: ComponentHealth): string {
  return component.health === 'alive' ? 'green' : component.health === 'down' ? 'red' : 'grey'
}

function shardLine(shard: ActiveShard | null): string {
  if (shard === null)
    return '<p data-empty>shard: none, every owner merge waits for the owner</p>'
  return `<p data-tone="green">shard ${escaped(shard.id)} · scope ${escaped(shard.scope)} · by ${escaped(shard.by)} · ${shard.leftMinutes} min left, until ${escaped(shard.until)}</p>`
}

function laneSection(board: Board): string {
  const rows = board.lanes.map((lane: LaneRow) => lane.card === null
    ? [cell(lane.lane), cell('free'), cell('')]
    : [cell(lane.lane), cell(`#${lane.card} ${lane.state ?? ''}`), cell(`taken ${ago(board.at, lane.since)}`)])
  const window = board.window
  return [
    '<section><h2>Lanes</h2>',
    table(['lane', 'card', 'since'], rows, 'no lane'),
    `<p>window (Operator): <span data-tone="${healthTone(window)}">${escaped(window.health)}</span> · ${escaped(window.why)} · last sign ${escaped(ago(board.at, window.lastSign))}</p>`,
    shardLine(board.shard),
    '</section>',
  ].join('')
}

function executionSection(board: Board): string {
  const rows = board.execution.map((row: ExecutionRow) => [
    cell(`#${row.card}`),
    cell(row.pr === null ? '' : `PR #${row.pr}`),
    cell(row.stage),
    cell(ago(board.at, row.since)),
    cell(row.review ?? ''),
    row.markers.length === 0 ? cell('') : cell(row.markers.join(' · '), 'red'),
  ])
  return `<section><h2>Execution</h2>${table(['card', 'PR', 'stage', 'on stage since', 'review', ''], rows, 'no card in execution')}</section>`
}

function healthSection(board: Board): string {
  const rows = board.health.map(component => [cell(component.name), cell(component.health, healthTone(component)), cell(ago(board.at, component.lastSign)), cell(component.why)])
  const progress = board.progress.stalled
    ? `<p data-tone="red">no progress: no card advanced since ${escaped(ago(board.at, board.progress.last))}</p><p>cause: ${escaped(board.progress.cause ?? '')}</p>`
    : `<p data-tone="green">progress: a card advanced ${escaped(ago(board.at, board.progress.last))}</p>`
  return `<section><h2>Health</h2>${table(['component', 'state', 'last sign of life', ''], rows, 'nothing watched')}<p>Factory running ≠ healthy</p>${progress}</section>`
}

function contractSection(links: readonly ContractLink[]): string {
  const row = links.map(link => cell(`${link.link}: ${link.fact}`, link.green ? 'green' : 'red'))
  const finished = links.every(link => link.green)
  return `<section><h2>Bus contract v1</h2><table><tr>${row.join('')}</tr></table><p>${finished ? 'the rebuild is finished' : 'the rebuild is not finished'}</p></section>`
}

function taskQueueSection(board: Board): string {
  const blocks = board.queues.map((queue: TaskQueue) => [
    `<h3>${escaped(queue.queue)}</h3>`,
    table(['leased', 'card', 'holder', 'lease_gen', 'since'], queue.leased.map(task => [cell(task.taskKey), cell(`#${task.card}`), cell(task.holder ?? ''), cell(String(task.leaseGen)), cell(ago(board.at, task.since))]), 'none leased'),
    table(['waiting, in grant order', 'card'], queue.waiting.map(task => [cell(task.taskKey), cell(`#${task.card}`)]), 'none waiting'),
  ].join(''))
  return `<section><h2>Task queues</h2>${blocks.join('') || '<p data-empty>every queue is empty</p>'}</section>`
}

const STYLE = `
:root { color-scheme: light dark; --gap: 1rem; --green: oklch(0.65 0.15 145); --red: oklch(0.6 0.2 25); --grey: oklch(0.6 0 0); }
body { font-family: ui-monospace, monospace; margin: 0; padding: var(--gap); display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fit, minmax(min(36rem, 100%), 1fr)); }
table { border-collapse: collapse; inline-size: 100%; }
th, td { text-align: start; padding: 0.25lh 1ch; border-block-end: 1px solid var(--grey); }
[data-tone='green'] { color: var(--green); }
[data-tone='red'] { color: var(--red); font-weight: bold; }
[data-tone='grey'], [data-empty] { color: var(--grey); }
`

export function renderBoard(board: Board): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`,
    `<title>factory board · ${escaped(board.at)}</title>`,
    `<style>${STYLE}</style></head><body>`,
    `<header><h1>Factory board</h1><p>written ${escaped(board.at)}</p></header>`,
    queueSection(board),
    laneSection(board),
    executionSection(board),
    healthSection(board),
    contractSection(board.contract),
    taskQueueSection(board),
    '</body></html>',
    '',
  ].join('\n')
}

export function writeBoardPage(file: string, html: string, files: BoardFiles = DISK_FILES): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  files.write(temporary, html)
  files.rename(temporary, file)
}

export const ALIVE_MS = 2 * 60_000
export const LIVENESS_EVENTS = [NODE_EQUIVALENCE, 'netwatch.tick'] as const
export const SEEN_ON_THE_BUS = 0
export const WORKERS_WITHOUT_NODE_EVENTS: readonly string[] = ['restart']

const LAST_LIVENESS = `SELECT type, ts FROM events WHERE type IN (${LIVENESS_EVENTS.map(() => '?').join(', ')}) AND substr(actor, 1, ?) = ? ORDER BY id DESC LIMIT 1`

export interface Liveness {
  worker: string
  alive: boolean
  last: { type: string, ts: string } | null
}

export function processesOrNone(list: ProcessList): RunningProcess[] {
  try {
    return list()
  }
  catch {
    return []
  }
}

export function workerLiveness(db: DatabaseSync, now: Date): Liveness[] {
  return WORKERS.filter(worker => !WORKERS_WITHOUT_NODE_EVENTS.includes(worker)).map((worker) => {
    const prefix = `worker:${worker}:`
    const last = (db.prepare(LAST_LIVENESS).get(...LIVENESS_EVENTS, prefix.length, prefix) as { type: string, ts: string } | undefined) ?? null
    return { worker, alive: last !== null && now.getTime() - Date.parse(last.ts) < ALIVE_MS, last }
  })
}

export function watchedNow(busDir: string, processes: RunningProcess[], liveness: readonly Liveness[]): Watched[] {
  const on = switchedOn(busDir)
  const launches = workerLaunches(() => [])
  const pidOf = (markers: readonly string[]): number | null => runningInstance(processes, markers)?.pid ?? null
  const aliveOnBus = (worker: string): boolean => liveness.some(entry => entry.worker === worker && entry.alive)
  const pidOfWorker = (worker: string, markers: readonly string[]): number | null => WORKERS_WITHOUT_NODE_EVENTS.includes(worker) ? pidOf(markers) : aliveOnBus(worker) ? pidOf(markers) ?? SEEN_ON_THE_BUS : null
  return [
    { name: RUN_SCRIPT, actor: 'reducer', queue: null, pid: process.pid, wanted: true },
    { name: 'supervisor', actor: null, queue: null, pid: pidOf(SUPERVISOR_LAUNCH.markers), wanted: true },
    ...WORKERS.map(worker => ({ name: worker, actor: `worker:${worker}:`, queue: worker, pid: pidOfWorker(worker, launches[worker].markers), wanted: on.includes(worker) })),
  ]
}

function livenessWhy(entry: Liveness, now: Date): string {
  if (entry.last === null)
    return 'no node event on the bus'
  return entry.alive ? `${entry.last.type} ${ago(now.toISOString(), entry.last.ts)}` : `no node event since ${ago(now.toISOString(), entry.last.ts)}`
}

export function withLiveness(board: Board, liveness: readonly Liveness[], now: Date): Board {
  return {
    ...board,
    health: board.health.map((component) => {
      const entry = liveness.find(each => each.worker === component.name)
      return entry === undefined || component.health === 'off' ? component : { ...component, why: livenessWhy(entry, now) }
    }),
  }
}

function cardBodyText(db: DatabaseSync): (cardId: number) => string | null {
  return cardId => (db.prepare('SELECT text FROM card_bodies WHERE card_id = ?').get(cardId) as { text: string } | undefined)?.text ?? null
}

function boardNow(db: DatabaseSync, busDir: string, now: Date, processes: ProcessList): Board {
  const liveness = workerLiveness(db, now)
  const board = readBoard({ db, now, watched: watchedNow(busDir, processesOrNone(processes), liveness), leaseOrders: { answer: answerLeaseOrder(db, cardBodyText(db)) } })
  return withLiveness(board, liveness, now)
}

export function printBoard(busPath: string, now: Date, write: (text: string) => void, processes: ProcessList = psList()): number {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    write(renderBoard(boardNow(db, path.dirname(busPath), now, processes)))
    return 0
  }
  finally {
    db.close()
  }
}

export function runBoardCli(busPath: string = defaultBusPath()): number {
  if (!existsSync(busPath)) {
    console.error(`${PREFIX}no bus database at ${busPath}`)
    return 1
  }
  return printBoard(busPath, new Date(), text => process.stdout.write(text))
}

export interface BoardProjection {
  file: string
  project: (now: Date) => void
}

export function boardProjection(db: DatabaseSync, busPath: string): BoardProjection {
  const busDir = path.dirname(busPath)
  const file = path.join(busDir, BOARD_FILE)
  return {
    file,
    project: (now) => {
      try {
        writeBoardPage(file, renderBoard(boardNow(db, busDir, now, psList())))
      }
      catch (error) {
        console.error(`${PREFIX}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBoardCli()
