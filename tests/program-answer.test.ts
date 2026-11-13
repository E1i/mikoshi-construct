import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runCommand } from 'citty'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE } from '../scripts/core/bus-path.js'
import { openBus } from '../scripts/core/db.js'
import { WINDOW_REQUEST } from '../scripts/core/events.js'
import { ANSWER_ACTOR, answerWord } from '../scripts/owner/answer-request.js'
import { runOwnerAnswer } from '../scripts/owner/answer.js'
import { ownerChannelOfBus } from '../scripts/owner/channel.js'
import { ANSWER_EXIT, main } from '../src/program.js'
import { PLAIN_LORE } from '../src/ui/lore.js'

interface Room {
  home: string
  busPath: string
}

interface Request {
  id: number
  actor: string
  card_id: number | null
  payload: string
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rooms: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const made of rooms.splice(0))
    rmSync(made, { recursive: true, force: true })
})

function room(withBus = true): Room {
  const made = mkdtempSync(path.join(tmpdir(), 'construct-answer-cli-'))
  rooms.push(made)
  const home = path.join(made, 'home')
  mkdirSync(home)
  const busPath = path.join(made, 'repo-bus', 'bus.db')
  if (withBus)
    openBus(busPath).close()
  return { home, busPath }
}

async function answerThroughProgram(at: Room, words: string[]): Promise<{ exit: typeof process.exitCode, output: string }> {
  const written: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  const previousExit = process.exitCode
  vi.stubEnv(BUS_DB_VARIABLE, at.busPath)
  vi.stubEnv('HOME', at.home)
  try {
    process.exitCode = undefined
    await runCommand(main, { rawArgs: ['answer', '--plain', ...words] })
    return { exit: process.exitCode, output: written.join('') }
  }
  finally {
    write.mockRestore()
    process.exitCode = previousExit
  }
}

function requestsIn(busPath: string): Request[] {
  const db = openBus(busPath)
  try {
    return db.prepare('SELECT id, actor, card_id, payload FROM events WHERE type = ? ORDER BY id').all(WINDOW_REQUEST) as unknown as Request[]
  }
  finally {
    db.close()
  }
}

function wordsIn(channel: string): string[] {
  return existsSync(channel) ? readdirSync(channel).map(file => readFileSync(path.join(channel, file), 'utf8').split('\n')[1]!) : []
}

describe('construct answer <Q|#card> "words"', () => {
  it('writes one owner.answer request with the owner word through the writer owner:answer uses, and prints its result', async () => {
    const at = room()

    const { exit, output } = await answerThroughProgram(at, ['Q364', 'option', 'c'])

    expect(exit).toBe(ANSWER_EXIT.requested)
    const [request, ...more] = requestsIn(at.busPath)
    expect(more).toEqual([])
    expect(request).toMatchObject({ actor: ANSWER_ACTOR, card_id: null })
    expect(JSON.parse(request!.payload)).toEqual({ kind: 'owner.answer', id: 'Q364', text: 'option c', from: 'answer' })
    expect(output).toContain(PLAIN_LORE.ownerAnswer('answered', `window.request ${request!.id} (owner.answer Q364)`))
    expect(wordsIn(ownerChannelOfBus(at.home, at.busPath))).toEqual([answerWord('Q364', 'option c')])
  })

  it('names a card the way owner:answer names it, and writes the same request', async () => {
    const at = room()

    expect((await answerThroughProgram(at, ['#1905', 'go on'])).exit).toBe(ANSWER_EXIT.requested)
    const db = openBus(at.busPath)
    try {
      expect(runOwnerAnswer(['#1905', 'go on'], db, ownerChannelOfBus(at.home, at.busPath), new Date(), () => {})).toBe(0)
    }
    finally {
      db.close()
    }

    const [fromProgram, fromScript] = requestsIn(at.busPath)
    expect(fromProgram).toMatchObject({ actor: fromScript!.actor, card_id: 1905, payload: fromScript!.payload })
    expect(JSON.parse(fromProgram!.payload)).toEqual({ kind: 'owner.answer', card: 1905, text: 'go on', from: 'answer' })
  })

  it.each([[[]], [['Q1']], [['nonsense', 'words']], [['#0', 'words']]])('refuses %j and writes nothing', async (words) => {
    const at = room()

    const { exit } = await answerThroughProgram(at, words)

    expect(exit).toBe(ANSWER_EXIT.noTarget)
    expect(requestsIn(at.busPath)).toEqual([])
    expect(existsSync(ownerChannelOfBus(at.home, at.busPath))).toBe(false)
  })

  it('refuses where no bus is, and creates none', async () => {
    const at = room(false)

    const { exit } = await answerThroughProgram(at, ['Q1', 'the words'])

    expect(exit).toBe(ANSWER_EXIT.noBus)
    expect(existsSync(at.busPath)).toBe(false)
    expect(existsSync(ownerChannelOfBus(at.home, at.busPath))).toBe(false)
  })
})

describe('the product reaches the owner answer only through its guard-free writer', () => {
  const eslint = new ESLint({ cwd: root })

  async function refused(file: string, source: string): Promise<boolean> {
    const [result] = await eslint.lintText(source, { filePath: path.join(root, file) })
    return result!.messages.some(message => message.ruleId === 'no-restricted-imports')
  }

  it('lets src/program.ts import scripts/owner/answer-request.js and not the owner:answer entry', async () => {
    expect(await refused('src/program.ts', 'import { requestOwnerAnswer } from \'../scripts/owner/answer-request.js\'\n\nexport const probe = requestOwnerAnswer\n')).toBe(false)
    expect(await refused('src/program.ts', 'import { runOwnerAnswer } from \'../scripts/owner/answer.js\'\n\nexport const probe = runOwnerAnswer\n')).toBe(true)
  })

  it.each(['src/commands/probe.ts', 'src/commands/doctor/probe.ts', 'src/ui/probe.ts'])('refuses the writer to %s', async (file) => {
    const base = '../'.repeat(file.split('/').length - 1)
    expect(await refused(file, `import { requestOwnerAnswer } from '${base}scripts/owner/answer-request.js'\n\nexport const probe = requestOwnerAnswer\n`)).toBe(true)
  })
})
