import type { TaskStartDeps } from '../../ghosts/task-start.js'
import { describe, expect, it } from 'vitest'
import { runTaskStart } from '../../ghosts/task-start.js'

const NOW = new Date('2026-10-05T08:00:00.000Z')
const CARD = '#41 entry-card [implement/ghosts/M/cheap/owner] · depends — · blocks —'
const OTHER_CARD = '#41 renamed-card [implement/ghosts/M/cheap/owner] · depends — · blocks —'
const FIELDS = ['CONTRACT', 'EXPECT', 'ACTION', 'RESULT'] as const

function parkingText(card: string, touches: string): string {
  return `card: ${card}\nbranch: feat/entry\ntouches: ${touches}\ncontinue: stop\nwho: window\n\ndo it\n`
}

function world(parking?: Record<string, string>, parkingDir = '/parking'): { deps: TaskStartDeps, appended: string[], read: string[] } {
  const appended: string[] = []
  const read: string[] = []
  return {
    appended,
    read,
    deps: {
      cwd: '/repo',
      git: (_cwd, args) => {
        if (args[0] === 'show-ref')
          throw new Error('no such branch')
        return args[0] === 'rev-parse' ? '/work/repo\n' : ''
      },
      install: () => undefined,
      exists: () => false,
      append: (_file, text) => {
        appended.push(text)
      },
      now: () => NOW,
      session: 's1',
      handoffDir: '/handoff',
      readJournal: () => `${JSON.stringify({ event: 'intake', task: '41', card: CARD, confirmation: 'none', corrections: [], ts: NOW.toISOString() })}\n`,
      ...(parking === undefined
        ? {}
        : { parking: { dir: parkingDir, read: (file: string) => {
            read.push(file)
            return parking[file] ?? null
          } } }),
    },
  }
}

function entryOf(appended: string[]): Record<string, unknown> {
  return appended[0]!.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.event === 'entry')!
}

function printed(stdout: string[]): Record<string, string> {
  return Object.fromEntries(stdout.slice(1).map(row => [row.split(' ')[0]!, row.replace(/^\w+\s+\| /, '')]))
}

describe('task:start writes the CONTRACT and the EXPECT its caller printed', () => {
  it('writes the handed CONTRACT and EXPECT into the entry line unchanged and prints the same two', () => {
    const { deps, appended } = world()
    const handed = { CONTRACT: 'implement · cheap · owner · touches a.ts, b/** · law not recorded in the task file', EXPECT: 'expect none — n=0 for implement/M' }
    const result = runTaskStart(['feat/entry', '--card', CARD], deps, handed)
    expect(result.exitCode).toBe(0)
    expect(entryOf(appended)).toMatchObject(handed)
    expect(printed(result.stdout)).toMatchObject(handed)
    for (const field of FIELDS)
      expect(printed(result.stdout)[field]).toBe(entryOf(appended)[field])
  })

  it('keeps ACTION and RESULT its own when it is handed the other two', () => {
    const { deps, appended } = world()
    runTaskStart(['feat/entry', '--card', CARD], deps, { CONTRACT: 'C', EXPECT: 'E' })
    expect(entryOf(appended).ACTION).toMatch(/^task:start feat\/entry #41: cut \/work\/mc-41 from origin\/main; start line written to \/handoff\/ghosts\.jsonl$/)
    expect(entryOf(appended).RESULT).toBe('accepted · not started')
  })
})

describe('task:start without a caller reads the contract from the parking card', () => {
  it('writes and prints the touches of /parking/41.md, named by the number in --card', () => {
    const { deps, appended, read } = world({ '/parking/41.md': parkingText(CARD, 'a.ts, b/**') })
    const result = runTaskStart(['feat/entry', '--card', CARD], deps)
    expect(result.exitCode).toBe(0)
    expect(read).toEqual(['/parking/41.md'])
    const contract = 'implement · cheap · owner · touches a.ts, b/** · law not recorded on the card'
    expect(entryOf(appended).CONTRACT).toBe(contract)
    expect(printed(result.stdout).CONTRACT).toBe(contract)
  })

  it('names the missing file when the card has none, in the entry line and on stdout', () => {
    const { deps, appended } = world({})
    const result = runTaskStart(['feat/entry', '--card', CARD], deps)
    const contract = 'implement · cheap · owner · touches not recorded on the card: no parking file for #41 · law not recorded on the card'
    expect(entryOf(appended).CONTRACT).toBe(contract)
    expect(printed(result.stdout).CONTRACT).toBe(contract)
  })

  it('names the missing file when it is given no parking source at all', () => {
    const { deps, appended } = world()
    runTaskStart(['feat/entry', '--card', CARD], deps)
    expect(entryOf(appended).CONTRACT).toContain('touches not recorded on the card: no parking file for #41')
  })

  it('reads the directory --parking names instead of the default one', () => {
    const { deps, appended, read } = world({ '/other/41.md': parkingText(CARD, 'c.ts') }, '/parking')
    const result = runTaskStart(['feat/entry', '--card', CARD, '--parking', '/other'], deps)
    expect(result.exitCode).toBe(0)
    expect(read).toEqual(['/other/41.md'])
    expect(entryOf(appended).CONTRACT).toContain('touches c.ts')
  })

  it('refuses before writing anything when the parking file carries another card line', () => {
    const { deps, appended } = world({ '/parking/41.md': parkingText(OTHER_CARD, 'a.ts') })
    const result = runTaskStart(['feat/entry', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('/parking/41.md carries card')
    expect(result.stderr.join('\n')).toContain('nothing written')
    expect(appended).toEqual([])
  })

  it('names the reason when the parking file cannot be read as a card', () => {
    const { deps, appended } = world({ '/parking/41.md': 'not a parking file' })
    runTaskStart(['feat/entry', '--card', CARD], deps)
    expect(entryOf(appended).CONTRACT).toMatch(/touches not recorded on the card: .*41\.md/)
  })
})

describe('the entry line carries its schema', () => {
  it('writes schema 2 on the entry line and none on the start line', () => {
    const { deps, appended } = world()
    runTaskStart(['feat/entry', '--card', CARD], deps, { CONTRACT: 'C', EXPECT: 'E' })
    expect(entryOf(appended).schema).toBe(2)
    const start = appended[0]!.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.event === 'path')!
    expect(start).not.toHaveProperty('schema')
  })
})
