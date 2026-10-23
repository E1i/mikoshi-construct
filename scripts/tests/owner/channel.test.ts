import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consumeOwnerWord, OWNER_CHANNEL_HOME, ownerChannelOf, SAID_PREFIX, USED_WORD } from '../../owner/channel.js'
import { runOwnerSay } from '../../owner/say.js'

const REPO = path.join(import.meta.dirname, '..', '..', '..')
const HOME = '/Users/owner'
const GLOB = /[*?[{]/
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

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string')
    return [value]
  if (Array.isArray(value))
    return value.flatMap(stringsOf)
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(stringsOf)
  return []
}

function absolute(entry: string): string {
  return path.isAbsolute(entry) ? entry : `${REPO}${path.sep}${entry}`
}

function covers(allowed: string, home: string): boolean {
  const target = ownerChannelOf(home)
  const expanded = allowed.replace(/^~(?=\/|$)/, home)
  const literal = GLOB.exec(expanded)
  if (literal !== null)
    return target.startsWith(absolute(expanded.slice(0, literal.index)))
  const resolved = path.resolve(REPO, expanded)
  return target === resolved || target.startsWith(`${resolved}${path.sep}`)
}

function coveringEntries(settings: unknown): string[] {
  return stringsOf(settings).filter(entry => entry.includes(OWNER_CHANNEL_HOME) || [homedir(), HOME].some(home => covers(entry, home)))
}

describe('the owner channel', () => {
  it('sandbox allowWrite does not cover the owner channel', () => {
    const covering = ['~/.construct-owner', '~/.construct-owner/answers', '~', path.join(homedir(), '.construct-owner'), homedir(), '~/.construct*', '~/**', `${HOME}/.construct-owner`]
    const apart = ['~/.construct', '~/.construct/*', '~/.construct/**', '.', '/tmp/claude', path.join(homedir(), '.construct'), 'Bash(gh pr merge * --auto *)']
    expect(coveringEntries({ sandbox: { filesystem: { allowWrite: [...covering, ...apart] } } })).toEqual(covering)
    expect(coveringEntries({ sandbox: { filesystem: { writeAllow: ['~/.construct-owner'] } } })).toEqual(['~/.construct-owner'])
    expect(coveringEntries({ sandbox: { write: { allowOnly: ['~'] } }, permissions: { additionalDirectories: [homedir()] } })).toEqual(['~', homedir()])
    expect(coveringEntries({ env: { OWNER: 'echo ~/.construct-owner/answers/x' } })).toEqual(['echo ~/.construct-owner/answers/x'])

    const settings = JSON.parse(readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8')) as unknown
    expect(stringsOf(settings).length).toBeGreaterThan(0)
    expect(coveringEntries(settings)).toEqual([])
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
    expect(word!.release()).toBe(true)
    expect(word!.release()).toBe(false)
    expect(consumeOwnerWord(answers, 'first line')?.file).toBe(word!.file)
  })

  it('a channel that does not exist holds no word', () => {
    expect(consumeOwnerWord(channel(), 'anything')).toBeNull()
  })
})
