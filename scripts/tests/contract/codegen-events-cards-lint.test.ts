import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const PROBE = 'scripts/nodes/probe/hand-event-reader.ts'
const TEST_PROBE = 'scripts/tests/bus/hand-event-reader-probe.test.ts'
const HAND_EVENT_READER = /crosses the bus boundary through one reader/

const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { HAND_EVENT_READERS_EXCEPTED: EXCEPTED } = await import(CONFIG_URL) as { HAND_EVENT_READERS_EXCEPTED: string[] }

const eslint = new ESLint({ cwd: REPO_ROOT })

async function handEventReads(source: string, file = PROBE): Promise<number[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, file) })
  return result!.messages.filter(message => HAND_EVENT_READER.test(message.message)).map(message => message.line)
}

describe('hand-written boundary code for events is forbidden by lint', () => {
  it('lint refuses a hand-written event reader', async () => {
    const source = [
      'export function verdictOf(row: { payload: string }, payload: string): unknown {',
      '  const stored = JSON.parse(row.payload) as { verdict?: unknown }',
      '  const raw = JSON.parse(payload) as { verdict?: unknown }',
      '  return stored.verdict ?? raw.verdict',
      '}',
      '',
    ].join('\n')
    expect(await handEventReads(source)).toEqual([2, 3])
  })

  it('a payload read through payloadOf and the generated declaredPart is not a hand reader', async () => {
    const source = [
      'import type { StoredEvent } from \'../../core/stored.js\'',
      'import { declaredPart, REVIEW_RECORDED } from \'../../core/events.js\'',
      'import { payloadOf } from \'../../core/stored.js\'',
      'export const verdictOf = (event: StoredEvent): unknown => declaredPart(REVIEW_RECORDED, payloadOf(event)).verdict',
      '',
    ].join('\n')
    expect(await handEventReads(source)).toEqual([])
  })

  it('a JSON.parse of text that is not a payload is not an event reader', async () => {
    expect(await handEventReads('export const parsed = (text: string): unknown => JSON.parse(text)\n')).toEqual([])
  })

  it('a test under scripts/tests may build and read payloads by hand', async () => {
    expect(await handEventReads('export const read = (row: { payload: string }): unknown => JSON.parse(row.payload)\n', TEST_PROBE)).toEqual([])
  })

  it('lists each excepted file once, in order', () => {
    expect(EXCEPTED).toEqual([...new Set(EXCEPTED)].sort())
  })

  it('every excepted file still reads a payload by hand', async () => {
    const fixed: string[] = []
    for (const file of EXCEPTED) {
      const absolute = path.join(REPO_ROOT, file)
      if (!existsSync(absolute) || (await handEventReads(readFileSync(absolute, 'utf8'))).length === 0)
        fixed.push(file)
    }
    expect(fixed).toEqual([])
  })

  it('the rule stands aside for every excepted file', async () => {
    for (const file of EXCEPTED) {
      const [result] = await eslint.lintText(readFileSync(path.join(REPO_ROOT, file), 'utf8'), { filePath: path.join(REPO_ROOT, file) })
      expect(result!.messages.filter(message => HAND_EVENT_READER.test(message.message)), file).toEqual([])
    }
  })
})
