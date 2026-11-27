import type { Graph } from '../../ci/layers.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { handEventReadersExcepted, LINT_CONFIG, selectRun, STALE_EXCEPTION_CHECK } from '../../ci/layers.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const CONFIG_TEXT = readFileSync(path.join(REPO_ROOT, LINT_CONFIG), 'utf8')
const { HAND_EVENT_READERS_EXCEPTED } = await import(pathToFileURL(path.join(REPO_ROOT, LINT_CONFIG)).href) as { HAND_EVENT_READERS_EXCEPTED: string[] }

const EXCEPTED_FILE = 'scripts/window/watch.ts'
const EXCEPTED_FILE_TEST = 'scripts/tests/window/watch.test.ts'
const PLAIN_FILE = 'scripts/window/plain.ts'
const PLAIN_FILE_TEST = 'scripts/tests/window/plain.test.ts'

const GRAPH: Graph = new Map([
  [EXCEPTED_FILE, []],
  [PLAIN_FILE, []],
  [EXCEPTED_FILE_TEST, [EXCEPTED_FILE]],
  [PLAIN_FILE_TEST, [PLAIN_FILE]],
  [STALE_EXCEPTION_CHECK, []],
])

function moduleText(module: string): string {
  return module === LINT_CONFIG ? CONFIG_TEXT : ''
}

function testsOf(changed: string[]): string[] {
  const run = selectRun(changed, GRAPH, moduleText)
  if (run.kind !== 'layers')
    throw new Error(`expected a layer run, got: ${run.why}`)
  return run.tests
}

describe('a pull request touching a hand-event-reader excepted file runs the stale-exception check', () => {
  it('reads the excepted list the lint config exports', () => {
    expect(handEventReadersExcepted(CONFIG_TEXT)).toEqual(HAND_EVENT_READERS_EXCEPTED)
    expect(HAND_EVENT_READERS_EXCEPTED).toContain(EXCEPTED_FILE)
  })

  it('a change to an excepted file adds the check outside its layer', () => {
    expect(testsOf([EXCEPTED_FILE])).toEqual([EXCEPTED_FILE_TEST, STALE_EXCEPTION_CHECK].sort())
  })

  it('a change to a file the list does not name leaves the check out', () => {
    expect(testsOf([PLAIN_FILE])).toEqual([PLAIN_FILE_TEST])
  })

  it('a graph without the check adds nothing', () => {
    const graph: Graph = new Map([...GRAPH].filter(([file]) => file !== STALE_EXCEPTION_CHECK))
    const run = selectRun([EXCEPTED_FILE], graph, moduleText)
    expect(run.kind === 'layers' ? run.tests : run.why).toEqual([EXCEPTED_FILE_TEST])
  })
})
