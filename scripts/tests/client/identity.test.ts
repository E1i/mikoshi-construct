import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SESSION_VARIABLE, USER_SETTINGS } from '../../ports/client/claude/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'
import { USER_SETTINGS as WATCH_SETTINGS } from '../../window/watch.js'
import { requestSession } from '../../window/window-requests.js'

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SESSION_NAME = ['CLAUDE', 'CODE', 'SESSION', 'ID'].join('_')
const SETTINGS_PATH = ['~', '.claude', 'settings.json'].join('/')
const SESSION_READERS = [
  'nodes/close/task-close.ts',
  'window/eddies-measure.ts',
  'window/window-heartbeat.ts',
  'window/window-requests.ts',
  'ports/task-start.ts',
  'intake/intake.ts',
]
const IDENTITY_FILES = [...SESSION_READERS, 'window/watch.ts']
const ENV_READ_OF_THE_NAME = /env\[SESSION_VARIABLE\]/

function sourceOf(file: string): string {
  return readFileSync(path.join(SCRIPTS, file), 'utf8')
}

it('ownSession reads the session of the running client and null without one', () => {
  const adapter = clientAdapter()
  expect(adapter.ownSession({ [SESSION_NAME]: 'sess-1575' })).toBe('sess-1575')
  expect(adapter.ownSession({})).toBeNull()
  expect(adapter.ownSession({ [SESSION_NAME]: '' })).toBeNull()
})

it('the session variable name stands only in the adapter among the identity files', () => {
  expect(SESSION_VARIABLE).toBe(SESSION_NAME)
  expect(sourceOf('ports/client/claude/adapter.ts')).toContain(SESSION_NAME)
  for (const file of IDENTITY_FILES)
    expect(sourceOf(file), file).not.toContain(SESSION_NAME)
  for (const file of SESSION_READERS) {
    expect(sourceOf(file), file).toContain('ownSession(')
    expect(sourceOf(file), file).not.toMatch(ENV_READ_OF_THE_NAME)
  }
})

it('watch names the settings path the adapter owns and does not spell it', () => {
  expect(USER_SETTINGS).toBe(SETTINGS_PATH)
  expect(WATCH_SETTINGS).toBe(USER_SETTINGS)
  expect(sourceOf('window/watch.ts')).not.toContain(SETTINGS_PATH)
})

it('a request keeps its trimmed session and goes by hand on a blank one', () => {
  expect(requestSession({ [SESSION_NAME]: '  sess-1575  ' })).toBe('sess-1575')
  expect(requestSession({ [SESSION_NAME]: '   ' })).toBe(requestSession({}))
})
