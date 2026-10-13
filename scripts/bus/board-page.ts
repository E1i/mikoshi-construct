import type { DatabaseSync } from 'node:sqlite'
import type { ParkingReads } from '../shift/parking.js'
import type { RunningProcess } from './bg.js'
import type { Board, ComponentHealth, ContractLink, ExecutionRow, LaneRow, QueueCard, TaskQueue, Watched } from './board.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { defaultParking } from '../ghosts/handoff-check.js'
import { answerLeaseOrder } from './answer-worker.js'
import { parkedCardText } from './answerer.js'
import { psList, RUN_SCRIPT, runningInstance } from './bg.js'
import { BOARD_FILE, parkingLanes, readBoard } from './board.js'
import { journalPath } from './import.js'
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

function laneSection(board: Board): string {
  const rows = board.lanes.map((lane: LaneRow) => lane.card === null
    ? [cell(lane.lane), cell('free'), cell('')]
    : [cell(lane.lane), cell(`#${lane.card} ${lane.state ?? ''}`), cell(`taken ${ago(board.at, lane.since)}`)])
  const window = board.window
  return [
    '<section><h2>Lanes</h2>',
    table(['lane', 'card', 'since'], rows, 'no lane'),
    `<p>window (Operator): <span data-tone="${healthTone(window)}">${escaped(window.health)}</span> · ${escaped(window.why)} · last sign ${escaped(ago(board.at, window.lastSign))}</p>`,
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

export function watchedNow(busDir: string, processes: RunningProcess[]): Watched[] {
  const on = switchedOn(busDir)
  const launches = workerLaunches(() => [])
  const pidOf = (markers: readonly string[]): number | null => runningInstance(processes, markers)?.pid ?? null
  return [
    { name: RUN_SCRIPT, actor: 'reducer', queue: null, pid: process.pid, wanted: true },
    { name: 'supervisor', actor: null, queue: null, pid: pidOf(SUPERVISOR_LAUNCH.markers), wanted: true },
    ...WORKERS.map(worker => ({ name: worker, actor: `worker:${worker}:`, queue: worker, pid: pidOf(launches[worker].markers), wanted: on.includes(worker) })),
  ]
}

export interface BoardProjection {
  file: string
  project: (now: Date) => void
}

export function boardProjection(db: DatabaseSync, busPath: string): BoardProjection {
  const busDir = path.dirname(busPath)
  const file = path.join(busDir, BOARD_FILE)
  const reads: ParkingReads = {
    cwd: process.cwd(),
    handoffDir: path.dirname(journalPath()),
    listDir: dir => readdirSync(dir),
    read: target => readFileSync(target, 'utf8'),
    exists: existsSync,
    git: (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }),
    bus: busPath,
  }
  return {
    file,
    project: (now) => {
      try {
        const parking = defaultParking(os.homedir())
        const board = readBoard({ db, now, watched: watchedNow(busDir, psList()()), parking: parkingLanes(reads, parking), leaseOrders: { answer: answerLeaseOrder(db, parkedCardText(parking)) } })
        writeBoardPage(file, renderBoard(board))
      }
      catch (error) {
        console.error(`${PREFIX}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}
