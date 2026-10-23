import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consumeOwnerWord, ownerChannelOf, SAID_PREFIX, USED_WORD } from '../../owner/channel.js'
import { runOwnerSay } from '../../owner/say.js'

const REPO = path.join(import.meta.dirname, '..', '..', '..')
const HOME = '/Users/owner'
const SANDBOX_FILESYSTEM_KEYS = ['allowRead', 'allowWrite', 'denyRead', 'denyWrite']
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

function allowWriteOf(settings: unknown): string[] {
  const sandbox = (settings as { sandbox?: unknown }).sandbox
  if (sandbox === undefined)
    return []
  const filesystem = (sandbox as { filesystem?: unknown }).filesystem
  if (filesystem === undefined)
    return []
  const unknownKeys = Object.keys(filesystem as object).filter(key => !SANDBOX_FILESYSTEM_KEYS.includes(key))
  if (unknownKeys.length > 0)
    throw new Error(`sandbox.filesystem names ${unknownKeys.join(', ')}, keys this check does not read`)
  const allow = (filesystem as { allowWrite?: unknown }).allowWrite
  if (allow === undefined)
    return []
  if (!Array.isArray(allow) || !allow.every(entry => typeof entry === 'string'))
    throw new Error('sandbox.filesystem.allowWrite is not a list of paths')
  return allow
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
  return allowWriteOf(settings).filter(allowed => [homedir(), HOME].some(home => covers(allowed, home)))
}

function sandboxWith(allowWrite: unknown): unknown {
  return { sandbox: { filesystem: { allowWrite } } }
}

describe('the owner channel', () => {
  it('sandbox allowWrite does not cover the owner channel', () => {
    const covering = ['~/.construct-owner', '~/.construct-owner/answers', '~', path.join(homedir(), '.construct-owner'), homedir(), '~/.construct*', '~/**', `${HOME}/.construct-owner`]
    const apart = ['~/.construct', '~/.construct/*', '~/.construct/**', '.', '/tmp/claude', path.join(homedir(), '.construct')]
    expect(coveringEntries(sandboxWith([...covering, ...apart]))).toEqual(covering)
    expect(() => coveringEntries({ sandbox: { filesystem: { writeAllow: ['~'] } } })).toThrow('writeAllow')
    expect(() => coveringEntries(sandboxWith('~'))).toThrow('not a list')

    const settings = JSON.parse(readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8')) as unknown
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
