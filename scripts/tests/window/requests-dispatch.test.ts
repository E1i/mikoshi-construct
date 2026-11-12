import type { RequestKind } from '../../window/window-requests.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dispatchRequest, REQUEST_EXECUTORS, requestFileOf } from '../../window/requests/index.js'
import { REQUEST_KINDS } from '../../window/window-requests.js'

const REQUESTS_DIR = path.resolve(import.meta.dirname, '../../window/requests')
const WINDOW_REQUESTS = path.resolve(import.meta.dirname, '../../window/window-requests.ts')
const SHARED_FILES = ['context.ts', 'index.ts', 'owner-move.ts', 'reach.ts', 'request.ts']
const ASKED = 7
const PAYLOAD = { kind: 'seeded' }

describe('the window requests: one file per kind, one dispatcher over REQUEST_KINDS', () => {
  it('every request kind has its own file under scripts/window/requests', () => {
    for (const kind of REQUEST_KINDS)
      expect(existsSync(path.join(REQUESTS_DIR, requestFileOf(kind))), kind).toBe(true)
  })

  it('no two kinds share a file, and every file there is a kind or a named shared part', () => {
    const kindFiles = REQUEST_KINDS.map(requestFileOf)
    expect(new Set(kindFiles).size).toBe(REQUEST_KINDS.length)
    expect(readdirSync(REQUESTS_DIR).filter(file => file.endsWith('.ts') && !SHARED_FILES.includes(file)).sort()).toEqual([...kindFiles].sort())
  })

  it('the dispatcher names exactly the kinds of REQUEST_KINDS', () => {
    expect(Object.keys(REQUEST_EXECUTORS).sort()).toEqual([...REQUEST_KINDS].sort())
  })

  it('the dispatcher reaches the executor its kind file exports', async () => {
    for (const kind of REQUEST_KINDS) {
      const file = await import(pathToFileURL(path.join(REQUESTS_DIR, requestFileOf(kind))).href) as { execute: unknown }
      expect(REQUEST_EXECUTORS[kind], kind).toBe(file.execute)
    }
  })

  it('dispatchRequest answers with the executor of the kind it is given', () => {
    const refusals: Partial<Record<RequestKind, string>> = { 'mode': 'mode names null', 'tree.cut': 'tree.cut names no card', 'numbers.foreign': 'numbers.foreign needs --ids' }
    for (const [kind, why] of Object.entries(refusals) as [RequestKind, string][])
      expect(dispatchRequest(null as never, kind, ASKED, PAYLOAD), kind).toMatchObject({ done: false, why: expect.stringContaining(why) })
  })

  it('window-requests.ts holds no table of executors any more', () => {
    expect(readFileSync(WINDOW_REQUESTS, 'utf8')).not.toMatch(/\bexecutors\b/)
  })
})
