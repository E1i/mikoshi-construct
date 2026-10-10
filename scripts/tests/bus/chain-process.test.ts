import type { ChainRow } from '../../bus/chain.js'
import type { ProcessTable } from '../../bus/chain-process.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { REAL_PROCESSES, stopChain } from '../../bus/chain-process.js'
import { pidAlive } from '../../shift/relaunch.js'
import { MAIN_1 } from './github-fake.js'

const roots: string[] = []
const groups: number[] = []

afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function chainRow(dir: string, leader: number | null, pid = leader ?? 1): ChainRow {
  return { dir, card_id: 809, parking: '/parking', sha: MAIN_1, pid, leader, boundary: 1, state: 'running' }
}

function fakeTable(commandLine: string | null): { table: ProcessTable, signalled: number[] } {
  const signalled: number[] = []
  return { table: { commandLine: () => commandLine, signalGroup: leader => signalled.push(leader) }, signalled }
}

async function until(condition: () => boolean): Promise<boolean> {
  for (let tries = 0; tries < 100 && !condition(); tries += 1)
    await new Promise(resolve => setTimeout(resolve, 50))
  return condition()
}

describe('stopping a running chain before its restart', () => {
  it('the signal reaches every process of a real detached chain group', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chain-group-'))
    roots.push(dir)
    const childFile = path.join(dir, 'child.pid')
    const leader = spawn('sh', ['-c', `sleep 60 & echo $! > "${childFile}"; wait`, 'shift', dir], { detached: true, stdio: 'ignore' })
    groups.push(leader.pid!)
    const exited = new Promise(resolve => leader.on('exit', resolve))
    expect(await until(() => existsSync(childFile) && readFileSync(childFile, 'utf8').trim() !== '')).toBe(true)
    const child = Number(readFileSync(childFile, 'utf8').trim())

    stopChain(chainRow(dir, leader.pid!), REAL_PROCESSES)

    await exited
    expect(await until(() => !pidAlive(child))).toBe(true)
  })

  it('a dead chain is restarted without a signal', () => {
    const { table, signalled } = fakeTable(null)
    expect(() => stopChain(chainRow('/shift/lane-1', 4242), table)).not.toThrow()
    expect(signalled).toEqual([])
  })

  it('a pid that is now someone else\'s is never signalled', () => {
    const { table, signalled } = fakeTable('/usr/bin/vim notes.md')
    expect(() => stopChain(chainRow('/shift/lane-1', 4242), table)).toThrow('PID 4242 is not the chain in /shift/lane-1')
    expect(signalled).toEqual([])
  })

  it('a live chain that recorded no process group is never signalled', () => {
    const { table, signalled } = fakeTable('node /x/tsx scripts/shift/shift.ts /shift/lane-1 --chain')
    expect(() => stopChain(chainRow('/shift/lane-1', null, 4242), table)).toThrow('recorded no process group')
    expect(signalled).toEqual([])
  })

  it('a failed signal is not swallowed', () => {
    const table: ProcessTable = { commandLine: () => 'node /usr/local/bin/pnpm shift /shift/lane-1 --chain', signalGroup: () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    } }
    expect(() => stopChain(chainRow('/shift/lane-1', 4242), table)).toThrow('kill ESRCH')
  })
})
