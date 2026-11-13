import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { WINDOW_REQUEST } from '../../core/events.js'
import { ANSWER_SOURCE } from '../../core/inbox.js'
import { ANSWER_ACTOR, ANSWER_FROM, ANSWER_SESSION, answerWord, ownerAnswerOf, requestOwnerAnswer, writeAnswerRequest } from '../../owner/answer-request.js'
import { WINDOW_ACTOR } from '../../window/window-requests.js'

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WRITER = path.join(scripts, 'owner', 'answer-request.ts')
const RUNTIME_IMPORT = /^(?:import|export) (?!type\b)[^'"]*from '(\.[^']+)'/gm
const ENTRY_GUARD = 'process.argv[1]'
const NEVER_REACHED = ['policy/decisions/add.ts', 'policy/decisions/window-door.ts', 'window/window-requests.ts', 'core/inbox.ts', 'core/queue.ts', 'owner/answer.ts']

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function closureOf(entry: string): string[] {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file))
      continue
    seen.add(file)
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(RUNTIME_IMPORT)) {
      const target = path.resolve(path.dirname(file), specifier!).replace(/\.js$/, '.ts')
      if (existsSync(target))
        pending.push(target)
    }
  }
  return [...seen]
}

function room(): { busPath: string, channel: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'answer-request-'))
  made.push(dir)
  return { busPath: path.join(dir, 'bus.db'), channel: path.join(dir, 'owner-answers') }
}

describe('the guard-free writer of the owner.answer request', () => {
  it('reaches no module with an entry guard, nor the request executor or the decisions adder', () => {
    const closure = closureOf(WRITER)
    expect(closure.filter(file => readFileSync(file, 'utf8').includes(ENTRY_GUARD)).map(file => path.relative(scripts, file))).toEqual([])
    expect(closure.map(file => path.relative(scripts, file)).filter(file => NEVER_REACHED.includes(file))).toEqual([])
  })

  it('writes as the window request door does, under the owner-answer session and the answer source', () => {
    expect(ANSWER_ACTOR).toBe(`${WINDOW_ACTOR}${ANSWER_SESSION}`)
    expect(ANSWER_FROM).toBe(ANSWER_SOURCE)
  })

  it.each([
    [['Q12', 'the words'], { target: { id: 'Q12' }, label: 'Q12', words: 'the words' }],
    [['#1905', '  go on '], { target: { card: 1905 }, label: '#1905', words: 'go on' }],
    [['1905', 'go on'], { target: { card: 1905 }, label: '#1905', words: 'go on' }],
    [['Q12', ''], null],
    [['Q12', '--flag'], null],
    [['nonsense', 'words'], null],
    [[undefined, 'words'], null],
  ] as const)('reads %j as %j', (args, answer) => {
    expect(ownerAnswerOf(args[0], args[1])).toEqual(answer)
  })

  it('says the word and writes one request with it', () => {
    const { busPath, channel } = room()
    const db = openBus(busPath)
    try {
      const written = writeAnswerRequest(db, channel, ownerAnswerOf('#7', 'go on')!, new Date('2026-11-14T00:00:00Z'))
      const rows = db.prepare('SELECT id, actor, card_id, payload FROM events WHERE type = ?').all(WINDOW_REQUEST) as unknown as { id: number, actor: string, card_id: number, payload: string }[]
      expect(rows).toEqual([{ id: written.request, actor: ANSWER_ACTOR, card_id: 7, payload: JSON.stringify({ kind: 'owner.answer', card: 7, text: 'go on', from: ANSWER_FROM }) }])
      expect(written.label).toBe('#7')
      expect(readdirSync(channel).map(file => readFileSync(path.join(channel, file), 'utf8').split('\n')[1])).toEqual([answerWord('#7', 'go on')])
    }
    finally {
      db.close()
    }
  })

  it('opens no bus that is not there and says nothing', () => {
    const { busPath, channel } = room()
    expect(requestOwnerAnswer(busPath, channel, ownerAnswerOf('Q1', 'words')!, new Date())).toBeNull()
    expect(existsSync(busPath)).toBe(false)
    expect(existsSync(channel)).toBe(false)
  })
})
