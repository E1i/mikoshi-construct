import type { SessionEnd } from '../../miko/loop.js'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { pauseUntilCtrlC, sessionCtrlCsStillInFlight } from '../../miko/loop.js'

const SHORT_PAUSE_MS = 200

describe('the Ctrl-C that ended the session is not read as a Ctrl+C in the pause, whichever the loop dispatches first', () => {
  it.each([
    { name: 'a session the Ctrl-C ended before the loop saw it', end: { code: null, signal: 'SIGINT' }, seen: 0, inFlight: 1 },
    { name: 'a session the Ctrl-C ended after the loop saw it', end: { code: null, signal: 'SIGINT' }, seen: 1, inFlight: 0 },
    { name: 'a session that exited on its own', end: { code: 0, signal: null }, seen: 0, inFlight: 0 },
    { name: 'a session another signal ended', end: { code: null, signal: 'SIGTERM' }, seen: 0, inFlight: 0 },
  ] satisfies { name: string, end: SessionEnd, seen: number, inFlight: number }[])('$name leaves $inFlight Ctrl-C in flight', ({ end, seen, inFlight }) => {
    expect(sessionCtrlCsStillInFlight(end, seen)).toBe(inFlight)
  })

  it.each([
    { sessionCtrlCs: 0, sigints: 1, end: 'ctrl-c' },
    { sessionCtrlCs: 1, sigints: 1, end: 'elapsed' },
    { sessionCtrlCs: 1, sigints: 2, end: 'ctrl-c' },
  ])('a pause owing $sessionCtrlCs session Ctrl-C ends $end after $sigints SIGINT', async ({ sessionCtrlCs, sigints, end }) => {
    const listeners = process.listenerCount('SIGINT')
    const pause = pauseUntilCtrlC(SHORT_PAUSE_MS, sessionCtrlCs)
    for (let n = 0; n < sigints; n++)
      process.emit('SIGINT', 'SIGINT')
    expect(await pause).toBe(end)
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })
})
