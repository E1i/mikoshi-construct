import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { liveSessionIn } from '../../nodes/answer/answerer.js'
import { OsProcessTable } from '../../ports/process-table.js'
import { liveSessionHolds } from '../../ports/worktree.js'

const SMALL_SYSTEM_BINARY = '/bin/sleep'
const VERSION_NAME = '2.1.318'
const ANOTHER_NAME = 'notasession'
const LONG_ENOUGH_SECONDS = '600'

const lsofAbsent = spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error !== undefined

let running: ChildProcess | undefined
let home: string | undefined

function stillRunning(child: ChildProcess | undefined): boolean {
  return child !== undefined && child.exitCode === null && child.signalCode === null
}

afterEach(async () => {
  if (running !== undefined && stillRunning(running)) {
    const exited = once(running, 'exit')
    running.kill('SIGKILL')
    await exited
  }
  running = undefined
  if (home !== undefined)
    rmSync(home, { recursive: true, force: true })
  home = undefined
})

function resignSoMacosDoesNotKillTheCopy(binary: string): void {
  if (process.platform === 'darwin')
    execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'ignore' })
}

async function processNamedIn(name: string): Promise<string> {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'session-process-name-')))
  const tree = path.join(home, 'tree')
  mkdirSync(tree)
  const binary = path.join(home, name)
  copyFileSync(SMALL_SYSTEM_BINARY, binary)
  resignSoMacosDoesNotKillTheCopy(binary)
  running = spawn(binary, [LONG_ENOUGH_SECONDS], { cwd: tree, stdio: 'ignore' })
  await once(running, 'spawn')
  return tree
}

function listedByItsOwnName(name: string, tree: string): boolean {
  const listing = spawnSync('lsof', ['-a', '-c', name, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout
  return listing.split('\n').includes(`n${tree}`)
}

function clientListingNames(tree: string): boolean {
  const read = new OsProcessTable().clientCwds()
  expect(read.kind).toBe('listed')
  return read.kind === 'listed' && read.cwds.includes(tree)
}

it.skipIf(lsofAbsent)('a live process named by a version holds the tree it stands in', async () => {
  const tree = await processNamedIn(VERSION_NAME)
  expect(clientListingNames(tree)).toBe(true)
  expect(liveSessionHolds(tree)).toBe(true)
  expect(stillRunning(running)).toBe(true)
})

it.skipIf(lsofAbsent)('the answerer sees a live process named by a version in the card tree', async () => {
  const tree = await processNamedIn(VERSION_NAME)
  expect(liveSessionIn({ session: 'a-session', worktree: tree, branch: 'feat/a-card' })).toContain(tree)
  expect(stillRunning(running)).toBe(true)
})

it.skipIf(lsofAbsent)('a live process with another name does not hold the tree it stands in', async () => {
  const tree = await processNamedIn(ANOTHER_NAME)
  expect(listedByItsOwnName(ANOTHER_NAME, tree)).toBe(true)
  expect(clientListingNames(tree)).toBe(false)
  expect(liveSessionHolds(tree)).toBe(false)
  expect(liveSessionIn({ session: 'a-session', worktree: tree, branch: 'feat/a-card' })).toBeNull()
  expect(stillRunning(running)).toBe(true)
})
