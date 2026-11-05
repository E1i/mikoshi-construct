import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { isSessionAlive } from '../../ladder/watch-process.js'
import { launchIsolationCommand } from '../../nodes/launch/launch-worker.js'
import { reviewIsolationCommand } from '../../nodes/review/review-worker.js'
import { clientAdapter } from '../../ports/client/index.js'
import { HEADLESS_FLAGS } from '../../ports/session.js'

const SESSION = 'session-1578'
const LISTING = 'p42\nfcwd\nn/tree\n'
const PATH_ON_ENTRY = process.env.PATH

const stubs: string[] = []

afterEach(() => {
  process.env.PATH = PATH_ON_ENTRY
  for (const dir of stubs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function lsofStub(script: string): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'client-process-'))
  stubs.push(dir)
  writeFileSync(path.join(dir, 'lsof'), `#!/bin/sh\n${script}\n`)
  chmodSync(path.join(dir, 'lsof'), 0o755)
  process.env.PATH = `${dir}${path.delimiter}${PATH_ON_ENTRY}`
}

describe('the client process', () => {
  it('the adapter recognises the client process and its session marker', () => {
    const { isClient, sessionMarker } = clientAdapter().processes
    expect(isClient('claude -p')).toBe(true)
    expect(isClient('/opt/bin/claude --resume x')).toBe(true)
    expect(isClient('node /opt/bin/claude -p')).toBe(true)
    expect(isClient('node tsx /opt/bin/claude')).toBe(false)
    expect(isClient('node scripts/window/exit.ts')).toBe(false)
    expect(sessionMarker(SESSION)).toBe(`--session-id ${SESSION}`)
  })

  it('a session is alive when a process carries the adapter marker', () => {
    const marker = clientAdapter().processes.sessionMarker(SESSION)!
    expect(isSessionAlive(SESSION, [{ pid: 1, args: `claude -p ${marker} go` }])).toBe(true)
    expect(isSessionAlive(SESSION, [{ pid: 1, args: 'claude -p --session-id other go' }])).toBe(false)
  })
})

describe('the live working directories of the client', () => {
  it('asks lsof for the working directory of the client processes', () => {
    lsofStub('printf \'%s \' "$@"')
    expect(clientAdapter().processes.liveCwds()).toEqual({ kind: 'listed', listing: '-a -c claude -d cwd -F n ' })
  })

  it('lists what lsof printed', () => {
    lsofStub(`printf '${LISTING}'`)
    expect(clientAdapter().processes.liveCwds()).toEqual({ kind: 'listed', listing: LISTING })
  })

  it('reads the lsof exit status of one as no process found, not as a failure', () => {
    lsofStub(`printf '${LISTING}'; exit 1`)
    expect(clientAdapter().processes.liveCwds()).toEqual({ kind: 'listed', listing: LISTING })
  })

  it('reports any other lsof failure as unreadable', () => {
    lsofStub('exit 2')
    expect(clientAdapter().processes.liveCwds().kind).toBe('unreadable')
  })
})

describe('the isolation command', () => {
  it('of a headless session is the client with the headless flags', () => {
    expect(clientAdapter().processes.isolationCommand()).toEqual(['claude', ...HEADLESS_FLAGS])
    expect(reviewIsolationCommand()).toEqual(clientAdapter().processes.isolationCommand())
  })

  it('of a card session carries the words of the client command before the card permission', () => {
    expect(launchIsolationCommand('claude')).toEqual(['claude', '--permission-mode', 'dontAsk'])
    expect(launchIsolationCommand('/opt/claude --settings /tmp/s.json')).toEqual(['/opt/claude', '--settings', '/tmp/s.json', '--permission-mode', 'dontAsk'])
  })
})
