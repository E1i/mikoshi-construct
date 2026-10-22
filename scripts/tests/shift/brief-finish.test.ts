import type { BriefFinishDeps } from '../../shift/brief-finish.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { EXPECT_LINE_INDEX } from '../../ghosts/expect.js'
import { runPnpmCommand } from '../../ghosts/install.js'
import { PREFIX, REAL_DEPS, runBriefFinish } from '../../shift/brief-finish-cli.js'
import { finishBrief, NO_PNPM_RUNNER } from '../../shift/brief-finish.js'

const CARD = 9402
const CARD_LINE = `#${CARD} a-card [implement/netwatch/M/ladder/auto] · depends — · blocks —`
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function workdir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'brief-finish-'))
  roots.push(root)
  return root
}

function briefText(sketch: string, expect?: string): string {
  const lines = ['# brief', `Sketch: ${sketch}`, 'body']
  if (expect !== undefined)
    lines.splice(EXPECT_LINE_INDEX, 0, expect)
  return lines.join('\n')
}

function parkedCard(root: string): string {
  const file = path.join(root, `${CARD}.md`)
  writeFileSync(file, parkingFileText({ card: CARD_LINE, branch: `feat/card-${CARD}`, touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }))
  return file
}

function depsOf(options: { status?: string, pnpm?: BriefFinishDeps['pnpm'], gitFails?: boolean }): { deps: BriefFinishDeps, git: string[][] } {
  const git: string[][] = []
  const deps: BriefFinishDeps = {
    cwd: '/repo',
    git: (_tree, args) => {
      git.push(args)
      if (options.gitFails === true)
        throw Object.assign(new Error('boom'), { stderr: '\nfatal: not a repo\nmore' })
      return args[0] === 'status' ? options.status ?? '' : 'main\n'
    },
    read: file => readFileSync(file, 'utf8'),
    pnpm: options.pnpm,
  }
  return { deps, git }
}

const CARD_REF = { id: CARD, name: 'a-card' } as Parameters<typeof finishBrief>[2]

describe('finishBrief', () => {
  it('leaves a brief whose Sketch line does not parse alone', () => {
    const file = path.join(workdir(), 'brief.md')
    writeFileSync(file, '# brief\nno sketch here\nbody')
    expect(finishBrief(depsOf({}).deps, '/tree', CARD_REF, file)).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe('# brief\nno sketch here\nbody')
  })

  it('reports a missing pnpm runner when the brief needs an expect line', () => {
    const file = path.join(workdir(), 'brief.md')
    writeFileSync(file, briefText('none — nothing to sketch'))
    expect(finishBrief(depsOf({}).deps, '/tree', CARD_REF, file)).toBe(NO_PNPM_RUNNER)
  })

  it('inserts the sampled expect line at the expect position', () => {
    const file = path.join(workdir(), 'brief.md')
    writeFileSync(file, briefText('none — nothing to sketch'))
    const calls: string[][] = []
    const { deps } = depsOf({ pnpm: (_cwd, args) => {
      calls.push(args)
      return { code: 0, stdout: 'noise\nexpect: sampled\n', stderr: '' }
    } })
    expect(finishBrief(deps, '/tree', CARD_REF, file)).toBeNull()
    expect(calls[0]).toContain('ghosts:expect-sample')
    expect(calls[0]).toEqual(expect.arrayContaining(['--sketch', 'no']))
    expect(readFileSync(file, 'utf8').split('\n')[EXPECT_LINE_INDEX]).toBe('expect: sampled')
  })

  it('names the first stderr line when the sampler fails', () => {
    const file = path.join(workdir(), 'brief.md')
    writeFileSync(file, briefText('none — nothing to sketch'))
    const { deps } = depsOf({ pnpm: () => ({ code: 3, stdout: '', stderr: '\nsampler broke\nrest' }) })
    expect(finishBrief(deps, '/tree', CARD_REF, file)).toBe('sampler broke')
  })

  it('commits a dirty tree as a sketch branch and rewrites line two', () => {
    const file = path.join(workdir(), 'brief.md')
    writeFileSync(file, briefText('none — nothing to sketch', 'expect: held'))
    const { deps, git } = depsOf({ status: ' M x.ts\n' })
    expect(finishBrief(deps, '/tree', CARD_REF, file)).toBeNull()
    expect(git.map(args => args[0])).toEqual(['status', 'rev-parse', 'checkout', 'add', 'commit', 'rev-parse', 'checkout'])
    expect(readFileSync(file, 'utf8').split('\n')[1]).toBe('Sketch: sketch/a-card @ main')
  })

  it('returns the first stderr line of a failing git call', () => {
    const file = path.join(workdir(), 'brief.md')
    writeFileSync(file, briefText('none — nothing to sketch'))
    expect(finishBrief(depsOf({ gitFails: true }).deps, '/tree', CARD_REF, file)).toBe('fatal: not a repo')
  })
})

describe('the brief-finish CLI', () => {
  it('prints usage and exits 2 without all three arguments', () => {
    const lines: string[] = []
    expect(runBriefFinish(['only-one'], depsOf({}).deps, line => lines.push(line))).toBe(2)
    expect(lines[0]).toContain(`${PREFIX}usage:`)
  })

  it('exits 1 when the card file is gone', () => {
    const lines: string[] = []
    expect(runBriefFinish([path.join(workdir(), 'gone.md'), '/tree', '/brief.md'], depsOf({}).deps, line => lines.push(line))).toBe(1)
    expect(lines[0]).toContain('is gone')
  })

  it('exits 1 when the card file does not parse', () => {
    const root = workdir()
    const file = path.join(root, `${CARD}.md`)
    writeFileSync(file, 'not a parking file')
    const lines: string[] = []
    expect(runBriefFinish([file, '/tree', '/brief.md'], depsOf({}).deps, line => lines.push(line))).toBe(1)
    expect(lines[0]).toContain(PREFIX)
  })

  it('exits 1 with the problem when the finish fails', () => {
    const root = workdir()
    const brief = path.join(root, 'brief.md')
    writeFileSync(brief, briefText('none — nothing to sketch'))
    const lines: string[] = []
    expect(runBriefFinish([parkedCard(root), '/tree', brief], depsOf({}).deps, line => lines.push(line))).toBe(1)
    expect(lines[0]).toContain(NO_PNPM_RUNNER)
  })

  it('exits 0 when the brief is finished', () => {
    const root = workdir()
    const brief = path.join(root, 'brief.md')
    writeFileSync(brief, briefText('none — nothing to sketch', 'expect: held'))
    const lines: string[] = []
    expect(runBriefFinish([parkedCard(root), '/tree', brief], depsOf({}).deps, line => lines.push(line))).toBe(0)
    expect(lines).toEqual([])
  })

  it('the brief-finish CLI takes its pnpm runner from the ladder', () => {
    expect(REAL_DEPS.pnpm).toBe(runPnpmCommand)
  })
})
