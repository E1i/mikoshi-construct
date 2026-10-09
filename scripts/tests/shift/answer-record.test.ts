import type { ShiftDeps } from '../../shift/shift.js'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAnswerRecord } from '../../shift/answer-record.js'
import { runClaude } from '../../shift/claude.js'
import { runShift } from '../../shift/shift.js'

const TASK = '804'
const BRIEF = 'Answer: the owner says yes, «да».\n'
const START = { event: 'path', task: TASK, path: 'cheap', branch: 'feat/answer-record' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World {
  root: string
  shift: string
  handoff: string
  tree: string
  stub: string
  journal: string
}

function world(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'answer-record-')))
  roots.push(root)
  const w = { root, shift: path.join(root, 'shift'), handoff: path.join(root, 'handoff'), tree: path.join(root, 'mc-804'), stub: path.join(root, 'claude-stub'), journal: '' }
  for (const dir of [w.shift, w.handoff, w.tree])
    mkdirSync(dir)
  writeFileSync(w.stub, '#!/bin/sh\ncat > /dev/null\n')
  chmodSync(w.stub, 0o755)
  writeFileSync(path.join(w.shift, 'shift.jsonl'), '')
  w.journal = path.join(w.handoff, 'ghosts.jsonl')
  writeFileSync(w.journal, `${JSON.stringify({ ...START, worktree: w.tree })}\n`)
  return w
}

function record(w: World, argv: string[], io = { out: [] as string[], err: [] as string[] }): number {
  return runAnswerRecord(argv, {
    cwd: w.shift,
    handoffDir: w.handoff,
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    realpath: realpathSync,
    append: (file, text) => appendFileSync(file, text),
    now: () => new Date('2026-10-10T09:00:00.000Z'),
    out: line => io.out.push(line),
    err: line => io.err.push(line),
  })
}

function answer(w: World, prompt: string, io = { out: [] as string[], err: [] as string[] }): Promise<number> {
  const deps: ShiftDeps = {
    cwd: w.root,
    claude: w.stub,
    header: '',
    handoffDir: w.handoff,
    readJournal: () => null,
    projectsDir: w.root,
    git: () => { throw new Error('git is not run by an answer') },
    install: () => { throw new Error('install is not run by an answer') },
    gh: () => { throw new Error('gh is not run by an answer') },
    listDir: () => [],
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: (file, text) => appendFileSync(file, text),
    now: () => new Date('2026-10-10T09:05:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000804',
    run: runClaude,
    out: line => io.out.push(line),
    err: line => io.err.push(line),
  }
  return runShift([w.shift, '--answer', TASK, '--prompt', prompt], deps)
}

function briefLines(w: World): Record<string, unknown>[] {
  return readFileSync(w.journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'answer-brief')
}

describe('pnpm answer:record', () => {
  it('the recorded line is the one shift --answer accepts for that file', async () => {
    const w = world()
    const prompt = path.join(w.shift, `answer-${TASK}.md`)
    writeFileSync(prompt, BRIEF)
    const io = { out: [] as string[], err: [] as string[] }
    expect(await answer(w, prompt, io)).toBe(1)
    expect(io.err.join('\n')).toContain('no event:answer-brief line')
    expect(record(w, [`#${TASK}`, `answer-${TASK}.md`])).toBe(0)
    expect(briefLines(w)).toEqual([{ event: 'answer-brief', task: TASK, file: prompt, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), ts: '2026-10-10T09:00:00.000Z' }])
    expect(await answer(w, prompt)).toBe(0)
    writeFileSync(prompt, `${BRIEF}edited after the record\n`)
    expect(await answer(w, prompt, io)).toBe(1)
    expect(io.err.join('\n')).toContain('not the journaled')
  })

  it('a file that is not an answer brief of the card is refused and nothing is written', () => {
    const w = world()
    const before = readFileSync(w.journal, 'utf8')
    writeFileSync(path.join(w.shift, 'answer-8040.md'), BRIEF)
    writeFileSync(path.join(w.shift, `brief-${TASK}.md`), BRIEF)
    writeFileSync(path.join(w.shift, `answer-${TASK}.txt`), BRIEF)
    writeFileSync(path.join(w.root, 'elsewhere.md'), BRIEF)
    symlinkSync(path.join(w.root, 'elsewhere.md'), path.join(w.shift, `answer-${TASK}-link.md`))
    const io = { out: [] as string[], err: [] as string[] }
    for (const file of ['answer-8040.md', `brief-${TASK}.md`, `answer-${TASK}.txt`, `answer-${TASK}-link.md`])
      expect(record(w, [TASK, file], io)).toBe(1)
    expect(record(w, [TASK, `answer-${TASK}-missing.md`], io)).toBe(1)
    expect(io.err.filter(line => line.includes(`is not an answer-${TASK}*.md; nothing written`))).toHaveLength(4)
    expect(io.err.at(-1)).toContain('does not exist; nothing written')
    expect(readFileSync(w.journal, 'utf8')).toBe(before)
    expect(io.out).toEqual([])
  })

  it('refuses a malformed call with the usage and writes nothing', () => {
    const w = world()
    const before = readFileSync(w.journal, 'utf8')
    const io = { out: [] as string[], err: [] as string[] }
    for (const argv of [[], [TASK], ['abc', `answer-${TASK}.md`], [TASK, `answer-${TASK}.md`, 'extra']])
      expect(record(w, argv, io)).toBe(2)
    expect(io.err.every(line => line.includes('usage: pnpm answer:record'))).toBe(true)
    expect(readFileSync(w.journal, 'utf8')).toBe(before)
  })
})
