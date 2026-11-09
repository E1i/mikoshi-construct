import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import EXCEPTED from '../../quality/real-time-waits-excepted.json' with { type: 'json' }

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const PROBES = ['scripts/tests/quality/real-time-probe.test.ts', 'tests/real-time-probe.test.ts']
const REAL_TIME_WAIT = /never waits on real time/

const eslint = new ESLint({ cwd: REPO_ROOT })

async function realTimeWaits(source: string, file = PROBES[0]!): Promise<number[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, file) })
  return result!.messages.filter(message => REAL_TIME_WAIT.test(message.message)).map(message => message.line)
}

describe('no real-time waits in tests', () => {
  it('a test that awaits sleep(100) is red under the rule', async () => {
    const source = [
      'import { setTimeout as sleep } from \'node:timers/promises\'',
      'export async function settle(): Promise<void> {',
      '  await sleep(100)',
      '}',
      '',
    ].join('\n')
    for (const probe of PROBES)
      expect(await realTimeWaits(source, probe)).toEqual([1, 3])
  })

  it('a bare setTimeout, setInterval or globalThis.setTimeout is a real-time wait', async () => {
    const source = [
      'export async function settle(): Promise<void> {',
      '  await new Promise(resolve => setTimeout(resolve, 50))',
      '  clearInterval(setInterval(() => {}, 10))',
      '  globalThis.setTimeout(() => {}, 10)',
      '}',
      '',
    ].join('\n')
    expect(await realTimeWaits(source)).toEqual([2, 3, 4])
  })

  it('the setTimeout of an injected clock is not a real-time wait', async () => {
    const source = [
      'const scheduled: (() => void)[] = []',
      'const clock = { setTimeout: (run: () => void) => scheduled.push(run), now: () => 0 }',
      'clock.setTimeout(() => {})',
      'export const context = { setTimeout: (run: () => void) => scheduled.push(run), clock }',
      'export const fired = scheduled.length',
      '',
    ].join('\n')
    expect(await realTimeWaits(source)).toEqual([])
  })

  it('a setTimeout inside the source text of a child process is not a wait of the test', async () => {
    expect(await realTimeWaits('export const child = \'setTimeout(() => process.exit(0), 300)\'\n')).toEqual([])
  })

  it('lists each excepted file once, in order', () => {
    expect(EXCEPTED).toEqual([...new Set(EXCEPTED)].sort())
  })

  it('every excepted file still waits on real time', async () => {
    const fixed: string[] = []
    for (const file of EXCEPTED) {
      const absolute = path.join(REPO_ROOT, file)
      if (!existsSync(absolute) || (await realTimeWaits(readFileSync(absolute, 'utf8'))).length === 0)
        fixed.push(file)
    }
    expect(fixed).toEqual([])
  })

  it('the rule stands aside for every excepted file', async () => {
    for (const file of EXCEPTED) {
      const [result] = await eslint.lintText(readFileSync(path.join(REPO_ROOT, file), 'utf8'), { filePath: path.join(REPO_ROOT, file) })
      expect(result!.messages.filter(message => REAL_TIME_WAIT.test(message.message))).toEqual([])
    }
  })
})
