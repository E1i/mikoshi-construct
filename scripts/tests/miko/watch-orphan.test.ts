import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'
import { ANOTHER_CONSUMER, ONCE_STORE, OnceStore, ownerFile } from '../../window/watch-store.js'
import { ONCE, parentGoneLine, WATCHING_FROM_CURSOR } from '../../window/watch.js'
import { waitFor } from '../wait-for.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const WATCH = path.join(REPO_ROOT, 'scripts', 'window', 'watch.ts')
const STORE_MODULE = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'window', 'watch-store.ts')).href
const DEADLINE_MS = 15_000
const HELD = 'held'

const roots: string[] = []
const pids: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

afterEach(() => {
  for (const pid of pids.splice(0)) {
    if (alive(pid))
      process.kill(pid, 'SIGKILL')
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function handoff(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-watch-orphan-'))
  roots.push(dir)
  return dir
}

function storeOf(dir: string): string {
  return path.join(dir, ONCE_STORE)
}

function openStore(dir: string): OnceStore {
  return OnceStore.open(storeOf(dir), { file: path.join(dir, 'none.json'), text: undefined }, () => ({ offset: 0, busId: 0 }))
}

function output(child: ReturnType<typeof spawn>): { stdout: () => string, stderr: () => string } {
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk
  })
  return { stdout: () => stdout, stderr: () => stderr }
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise(resolve => child.once('exit', resolve))
  return child.pid!
}

function plantOwner(dir: string, owner: { pid: number, parent: number }): void {
  writeFileSync(ownerFile(storeOf(dir)), `${JSON.stringify(owner)}\n`)
}

async function holdLock(dir: string, parent: number, releaseAfterMs?: number): Promise<ReturnType<typeof spawn>> {
  const script = [
    `const { OnceStore } = await import(${JSON.stringify(STORE_MODULE)})`,
    `const store = OnceStore.open(${JSON.stringify(storeOf(dir))}, { file: 'none.json', text: undefined }, () => ({ offset: 0, busId: 0 }), { pid: process.pid, parent: ${parent} })`,
    `process.stdout.write(${JSON.stringify(`${HELD}\n`)})`,
    releaseAfterMs === undefined ? 'setInterval(() => {}, 1000)' : `setTimeout(() => store.close(), ${releaseAfterMs}); setInterval(() => {}, 1000)`,
  ].join('\n')
  return holder(script)
}

async function holdRawLockThenRecord(dir: string, stale: { pid: number, parent: number }, recordAfterMs: number): Promise<ReturnType<typeof spawn>> {
  const script = [
    `const { DatabaseSync } = await import('node:sqlite')`,
    `const { writeFileSync } = await import('node:fs')`,
    `const db = new DatabaseSync(${JSON.stringify(storeOf(dir))})`,
    `db.exec('PRAGMA locking_mode = EXCLUSIVE')`,
    `db.exec('BEGIN IMMEDIATE')`,
    `writeFileSync(${JSON.stringify(ownerFile(storeOf(dir)))}, JSON.stringify(${JSON.stringify(stale)}))`,
    `process.stdout.write(${JSON.stringify(`${HELD}\n`)})`,
    `setTimeout(() => writeFileSync(${JSON.stringify(ownerFile(storeOf(dir)))}, JSON.stringify({ pid: process.pid, parent: ${process.pid} })), ${recordAfterMs})`,
    'setInterval(() => {}, 1000)',
  ].join('\n')
  return holder(script)
}

async function holder(script: string): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  pids.push(child.pid!)
  const seen = output(child)
  await waitFor(() => seen.stdout().includes(HELD), () => `"${HELD}" from the lock holder (stderr so far: ${JSON.stringify(seen.stderr())})`, DEADLINE_MS)
  return child
}

interface Orphan {
  watch: number
  parent: number
  stderr: () => string
}

async function orphanWatch(dir: string): Promise<Orphan> {
  const bus = path.join(dir, 'bus.db')
  openBus(bus).close()
  const parentScript = [
    `const { spawn } = await import('node:child_process')`,
    `const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(WATCH)}, ${JSON.stringify(ONCE)}], { stdio: ['ignore', 'ignore', 'inherit'] })`,
    `process.stdout.write(child.pid + '\\n')`,
    'setInterval(() => {}, 1000)',
  ].join('\n')
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, [WINDOW_VARIABLE]: WINDOW_MARK, CONSTRUCT_HANDOFF_DIR: dir, CONSTRUCT_BUS_DB: bus },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pids.push(parent.pid!)
  const seen = output(parent)
  await waitFor(() => /^\d+\n/.test(seen.stdout()), () => `the watch pid from its parent (stderr so far: ${JSON.stringify(seen.stderr())})`, DEADLINE_MS)
  const watch = Number(seen.stdout().trim())
  pids.push(watch)
  await waitFor(() => seen.stderr().includes(WATCHING_FROM_CURSOR), () => `"${WATCHING_FROM_CURSOR}" (stderr so far: ${JSON.stringify(seen.stderr())})`, DEADLINE_MS)
  const killed = new Promise(resolve => parent.once('exit', resolve))
  parent.kill('SIGKILL')
  await killed
  return { watch, parent: parent.pid!, stderr: seen.stderr }
}

describe('the --once cursor lock lives only with its owner', () => {
  it('a watch lock whose owner pid is dead is taken over by the next watch', async () => {
    const dir = handoff()
    await orphanWatch(dir)
    const store = openStore(dir)
    try {
      expect(store.opened.kind).toBe('stored')
    }
    finally {
      store.close()
    }
  }, 30_000)

  it('a lock whose owner is alive refuses the next watch at once, and never waits for it', async () => {
    const dir = handoff()
    const holder = await holdLock(dir, process.pid)
    const started = Date.now()
    expect(() => openStore(dir)).toThrow(`${ANOTHER_CONSUMER} on ${storeOf(dir)}`)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(alive(holder.pid!)).toBe(true)
  }, 30_000)

  it('a lock still held under a recorded dead owner is waited for and taken over the moment it is released', async () => {
    const dir = handoff()
    const releaseAfterMs = 1000
    const holder = await holdLock(dir, await deadPid(), releaseAfterMs)
    const started = Date.now()
    const store = openStore(dir)
    try {
      expect(Date.now() - started).toBeGreaterThanOrEqual(releaseAfterMs / 2)
      expect(store.opened.kind).toBe('stored')
      expect(alive(holder.pid!)).toBe(true)
    }
    finally {
      store.close()
    }
  }, 30_000)

  it('a stale owner record of a dead watch does not make the next watch wait for a live holder that follows', async () => {
    const dir = handoff()
    const dead = await deadPid()
    plantOwner(dir, { pid: dead, parent: dead })
    await holdLock(dir, process.pid)
    const started = Date.now()
    expect(() => openStore(dir)).toThrow(`${ANOTHER_CONSUMER} on ${storeOf(dir)}`)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 30_000)

  it('a live holder whose record still names a dead owner is refused as soon as its own record lands, not after the whole takeover wait', async () => {
    const dir = handoff()
    const dead = await deadPid()
    await holdRawLockThenRecord(dir, { pid: dead, parent: dead }, 300)
    const started = Date.now()
    expect(() => openStore(dir)).toThrow(`${ANOTHER_CONSUMER} on ${storeOf(dir)}`)
    expect(Date.now() - started).toBeLessThan(2000)
  }, 30_000)

  it('a watch whose parent has died exits and releases the lock', async () => {
    const dir = handoff()
    const orphan = await orphanWatch(dir)
    await waitFor(() => !alive(orphan.watch), () => `the orphaned watch ${orphan.watch} to exit (stderr so far: ${JSON.stringify(orphan.stderr())})`, DEADLINE_MS)
    expect(orphan.stderr()).toContain(parentGoneLine(orphan.parent))
    expect(existsSync(ownerFile(storeOf(dir)))).toBe(false)
    openStore(dir).close()
  }, 30_000)
})
