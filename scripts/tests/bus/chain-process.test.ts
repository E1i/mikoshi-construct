import type { ProcessTable } from '../../bus/chain-process.js'
import type { ChainRow, ChainState } from '../../bus/chain.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { chainProcess, launchProcess, REAL_PROCESSES, stopChain } from '../../bus/chain-process.js'
import { pidAlive } from '../../shift/relaunch.js'
import { waitFor } from '../wait-for.js'
import { MAIN_1 } from './github-fake.js'

const ARRIVAL_GUARD_MS = 25_000

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

function chainRow(dir: string, leader: number | null, pid = leader ?? 1, state: ChainState = 'running'): ChainRow {
  return { dir, card_id: 809, parking: '/parking', sha: MAIN_1, pid, leader, boundary: 1, state }
}

function fakeTable(commandLine: string | null): { table: ProcessTable, signalled: number[] } {
  const signalled: number[] = []
  return { table: { commandLine: () => commandLine, signalGroup: leader => signalled.push(leader) }, signalled }
}

describe('stopping a running chain before its restart', () => {
  it('the signal reaches every process of a real detached chain group', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chain-group-'))
    roots.push(dir)
    const childFile = path.join(dir, 'child.pid')
    const leader = spawn('sh', ['-c', `sleep 60 & echo $! > "${childFile}"; wait`, 'shift', dir], { detached: true, stdio: 'ignore' })
    groups.push(leader.pid!)
    const exited = new Promise(resolve => leader.on('exit', resolve))
    await waitFor(() => existsSync(childFile) && readFileSync(childFile, 'utf8').trim() !== '', () => `the child pid in ${childFile}`, ARRIVAL_GUARD_MS)
    const child = Number(readFileSync(childFile, 'utf8').trim())

    stopChain(chainRow(dir, leader.pid!), REAL_PROCESSES)

    await exited
    await waitFor(() => !pidAlive(child), () => `child ${child} of the signalled group to exit`, ARRIVAL_GUARD_MS)
  })

  it('a chain waiting on #N is a live process and is signalled like a running one', () => {
    const { table, signalled } = fakeTable('node /usr/local/bin/pnpm shift /shift/lane-1 --chain')
    stopChain(chainRow('/shift/lane-1', 4242, 4242, 'waiting'), table)
    expect(signalled).toEqual([4242])
  })

  it('a stopped chain is not signalled', () => {
    const { table, signalled } = fakeTable('node /usr/local/bin/pnpm shift /shift/lane-1 --chain')
    stopChain(chainRow('/shift/lane-1', 4242, 4242, 'stopped'), table)
    expect(signalled).toEqual([])
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

  it('a chain is known by its launch record, not by the shift words', () => {
    const known = fakeTable('node /opt/runner.js /shift/lane-1')
    stopChain(chainRow('/shift/lane-1', 4242), known.table)
    expect(known.signalled).toEqual([4242])
    expect(chainProcess(chainRow('/shift/lane-1', 4242), known.table)).toBe('live')

    const other = fakeTable('node /usr/local/bin/pnpm shift /shift/lane-2 --chain')
    expect(() => stopChain(chainRow('/shift/lane-1', 4242), other.table)).toThrow('PID 4242 is not the chain in /shift/lane-1')
    expect(other.signalled).toEqual([])
  })

  it('a launched session is live only while its group leader names its session', () => {
    expect(launchProcess({ pgid: 4242, session: 'session-1' }, fakeTable('sh -c claude shift -p --session-id session-1').table)).toBe('live')
    expect(launchProcess({ pgid: 4242, session: 'session-1' }, fakeTable('/usr/bin/vim notes.md').table)).toBe('foreign')
    expect(launchProcess({ pgid: 4242, session: 'session-1' }, fakeTable(null).table)).toBe('gone')
  })

  it('a failed signal is not swallowed', () => {
    const table: ProcessTable = { commandLine: () => 'node /usr/local/bin/pnpm shift /shift/lane-1 --chain', signalGroup: () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    } }
    expect(() => stopChain(chainRow('/shift/lane-1', 4242), table)).toThrow('kill ESRCH')
  })
})
