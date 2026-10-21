import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { LineStamper, STAMP_ENV, stampLogOutput, stampStream } from '../../bus/stamp.js'
import { SUPERVISOR_LAUNCH } from '../../bus/supervisor.js'
import { busLaunches } from '../../bus/workers.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const PACKAGE_SCRIPTS = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
const DETACHED_SCRIPTS = [...busLaunches(() => []), SUPERVISOR_LAUNCH].map(launch => launch.script)

function entryOf(script: string): string {
  const command = PACKAGE_SCRIPTS[script] ?? ''
  const match = /^node --import tsx (\S+)$/.exec(command)
  if (match === null)
    throw new Error(`package.json script ${script} is "${command}", not "node --import tsx <entry>"`)
  return readFileSync(path.join(REPO_ROOT, match[1]!), 'utf8')
}

const AT = '2026-10-20T11:36:00.000Z'
const stamper = (): LineStamper => new LineStamper(() => new Date(AT))

function captured(): { stream: Writable, text: () => string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString('utf8'))
      done()
    },
  })
  return { stream, text: () => chunks.join('') }
}

describe('the bus log stamper', () => {
  it('starts every line with the ISO time, also a line written in pieces and a last line with no newline', () => {
    const s = stamper()
    expect(s.stamp('one\ntw')).toBe(`${AT} one\n${AT} tw`)
    expect(s.stamp('o\n\nthree')).toBe(`o\n${AT} \n${AT} three`)
    expect(s.stamp('\n')).toBe('\n')
    expect(s.stamp('')).toBe('')
  })

  it('a stamped stream stamps strings and buffers and passes a non-text encoding through', () => {
    const { stream, text } = captured()
    stampStream(stream, stamper())
    stream.write('first\n')
    stream.write(Buffer.from('second\n'))
    stream.write('6869', 'hex')
    expect(text()).toBe(`${AT} first\n${AT} second\nhi`)
  })

  it('stamps nothing unless the detached start asked for it, and clears the switch so a child does not inherit it', () => {
    const asked: NodeJS.ProcessEnv = { [STAMP_ENV]: '1' }
    const notAsked: NodeJS.ProcessEnv = {}
    const write = process.stdout.write
    const writeErr = process.stderr.write
    try {
      stampLogOutput(notAsked)
      expect(process.stdout.write).toBe(write)
      stampLogOutput(asked)
      expect(asked[STAMP_ENV]).toBeUndefined()
      expect(process.stdout.write).not.toBe(write)
    }
    finally {
      process.stdout.write = write
      process.stderr.write = writeErr
    }
  })

  it('names every script a detached bus start launches, the supervisor and bus:run included', () => {
    expect(new Set(DETACHED_SCRIPTS)).toEqual(new Set(['bus:run', 'bus:bg', 'bus:review', 'bus:merge', 'bus:update', 'bus:launch', 'bus:restart', 'bus:answer', 'bus:close', 'bus:witness']))
  })

  it.each(DETACHED_SCRIPTS)('the entry behind %s imports stampLogOutput and calls it', (script) => {
    const source = entryOf(script)
    expect(source).toMatch(/^import \{ stampLogOutput \} from '\.\/stamp\.js'$/m)
    expect(source).toMatch(/^\s+stampLogOutput\(\)$/m)
  })
})
