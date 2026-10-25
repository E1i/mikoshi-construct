import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SUPERVISE_FLAG } from '../../supervisor/supervisor.js'
import { scanText } from '../../privacy/scan.js'

const PLIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supervisor/launchd/dev.mikoshi.bus.plist')
const RAISED_WITHIN_S = 30

type PlistValue = boolean | number | string | string[]

function decode(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', '\'').replaceAll('&amp;', '&')
}

function topLevelKeys(xml: string): Map<string, PlistValue> {
  const body = xml.slice(xml.indexOf('<dict>') + '<dict>'.length, xml.lastIndexOf('</dict>'))
  const entry = /<key>([^<]+)<\/key>\s*(?:<(true|false)\/>|<integer>(-?\d+)<\/integer>|<string>([^<]*)<\/string>|<array>([\s\S]*?)<\/array>|<dict>[\s\S]*?<\/dict>)/g
  const keys = new Map<string, PlistValue>()
  for (const [, key, flag, integer, string, array] of body.matchAll(entry)) {
    if (flag !== undefined)
      keys.set(key!, flag === 'true')
    else if (integer !== undefined)
      keys.set(key!, Number(integer))
    else if (string !== undefined)
      keys.set(key!, decode(string))
    else if (array !== undefined)
      keys.set(key!, [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => decode(match[1]!)))
    else
      keys.set(key!, 'dict')
  }
  return keys
}

const plist = readFileSync(PLIST, 'utf8')
const keys = topLevelKeys(plist)
const shellLine = (keys.get('ProgramArguments') as string[]).at(-1)!

describe('the bus agent keeps the supervisor alive', () => {
  it('has an unconditional KeepAlive, so launchd reruns the starter whenever it exits', () => {
    expect(keys.get('KeepAlive')).toBe(true)
  })

  it(`reruns the starter within ${RAISED_WITHIN_S} s of its last run, so a killed supervisor is raised by then`, () => {
    expect(keys.get('ThrottleInterval')).toBeTypeOf('number')
    expect(keys.get('ThrottleInterval') as number).toBeLessThanOrEqual(RAISED_WITHIN_S)
    expect(keys.has('StartInterval')).toBe(false)
  })

  it('starts at load and leaves the detached supervisor and workers running when the starter exits', () => {
    expect(keys.get('RunAtLoad')).toBe(true)
    expect(keys.get('AbandonProcessGroup')).toBe(true)
  })

  it(`runs the idempotent starter, never the supervisor itself, which relaunches itself detached on a bus code change`, () => {
    expect(shellLine).toMatch(/exec pnpm --silent bus:bg$/)
    expect(shellLine).not.toContain(SUPERVISE_FLAG)
  })

  it('is labelled after its file', () => {
    expect(keys.get('Label')).toBe(path.basename(PLIST, '.plist'))
  })

  it('names no home directory, so the file installs on any account', () => {
    expect(scanText(plist, PLIST).filter(violation => violation.kind === 'home-path')).toEqual([])
    expect(keys.has('WorkingDirectory')).toBe(false)
    expect(keys.has('StandardOutPath')).toBe(false)
  })
})
