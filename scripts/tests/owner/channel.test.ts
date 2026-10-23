import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consumeOwnerWord, ownerChannelOf, SAID_PREFIX, USED_WORD } from '../../owner/channel.js'
import { runOwnerSay } from '../../owner/say.js'

const REPO = path.join(import.meta.dirname, '..', '..', '..')
const HOME = '/Users/owner'
const NOW = new Date('2026-10-23T09:00:00.000Z')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function channel(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-channel-'))
  roots.push(root)
  return path.join(root, 'answers')
}

function allowWriteOf(settings: unknown): string[] {
  const allow = (settings as { sandbox?: { filesystem?: { allowWrite?: unknown } } }).sandbox?.filesystem?.allowWrite
  return Array.isArray(allow) ? allow.map(String) : []
}

function covers(allowed: string, target: string): boolean {
  const resolved = path.resolve(REPO, allowed.replace(/^~(?=\/|$)/, HOME))
  return target === resolved || target.startsWith(`${resolved}${path.sep}`)
}

describe('the owner channel', () => {
  it('sandbox allowWrite does not cover the owner channel', () => {
    const target = ownerChannelOf(HOME)
    expect(covers('~/.construct-owner', target)).toBe(true)
    expect(covers('~/.construct', target)).toBe(false)
    const settings = JSON.parse(readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8')) as unknown
    expect(allowWriteOf(settings).filter(allowed => covers(allowed, target))).toEqual([])
  })

  it('owner:say writes the text and the time into a new file of the channel', () => {
    const answers = channel()
    const lines: string[] = []
    expect(runOwnerSay(['  Q14: the second path.  '], answers, NOW, line => lines.push(line))).toBe(0)
    const [file] = readdirSync(answers)
    expect(lines).toEqual([`[owner:say] ${path.join(answers, file!)}`])
    expect(readFileSync(path.join(answers, file!), 'utf8')).toBe(`${SAID_PREFIX}${NOW.toISOString()}\nQ14: the second path.\n`)
  })

  it('owner:say takes exactly one non-empty text', () => {
    const answers = channel()
    const lines: string[] = []
    expect(runOwnerSay([], answers, NOW, line => lines.push(line))).toBe(2)
    expect(runOwnerSay(['a', 'b'], answers, NOW, () => {})).toBe(2)
    expect(runOwnerSay(['  '], answers, NOW, () => {})).toBe(2)
    expect(lines).toEqual([`[owner:say] usage: pnpm owner:say "<the owner's words>"`])
  })

  it('a word is consumed once, only as a whole line, never from the time line, and released back on demand', () => {
    const answers = channel()
    runOwnerSay(['first line\nsecond line'], answers, NOW, () => {})
    expect(consumeOwnerWord(answers, 'first')).toBeNull()
    expect(consumeOwnerWord(answers, `${SAID_PREFIX}${NOW.toISOString()}`)).toBeNull()
    const word = consumeOwnerWord(answers, 'second line')
    expect(word).not.toBeNull()
    expect(consumeOwnerWord(answers, 'first line')).toBeNull()
    expect(readdirSync(answers).every(name => name.endsWith(USED_WORD))).toBe(true)
    word!.release()
    expect(consumeOwnerWord(answers, 'first line')?.file).toBe(word!.file)
  })

  it('a channel that does not exist holds no word', () => {
    expect(consumeOwnerWord(channel(), 'anything')).toBeNull()
  })
})
