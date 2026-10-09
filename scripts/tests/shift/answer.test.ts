import type { ShiftDeps } from '../../shift/shift.js'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { answerLogPath, answerPidPath } from '../../shift/answer.js'
import { runClaude } from '../../shift/claude.js'
import { runShift } from '../../shift/shift.js'

const TASK = '758'
const BRIEF = 'Answer: the owner says yes.\n'
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
  out: string
  stub: string
  prompt: string
  journal: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function world(options: { started?: boolean, journaled?: string | null } = {}): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-answer-')))
  roots.push(root)
  const w = { root, shift: path.join(root, 'shift'), handoff: path.join(root, 'handoff'), tree: path.join(root, 'mc-758'), out: path.join(root, 'out'), stub: path.join(root, 'claude-stub'), prompt: '', journal: '' }
  for (const dir of [w.shift, w.handoff, w.tree, w.out])
    mkdirSync(dir)
  writeFileSync(w.stub, `#!/bin/sh\necho $$ > "${w.out}/pid"\npwd > "${w.out}/cwd"\nprintf '%s\\n' "$*" > "${w.out}/argv"\nprintf '%s' "$GH_TOKEN" > "${w.out}/token"\ncat > "${w.out}/stdin"\necho "stub claude ran"\n`)
  chmodSync(w.stub, 0o755)
  w.prompt = path.join(w.shift, `answer-${TASK}.md`)
  w.journal = path.join(w.handoff, 'ghosts.jsonl')
  writeFileSync(w.prompt, BRIEF)
  writeFileSync(path.join(w.shift, 'shift.jsonl'), '')
  const lines: object[] = []
  if (options.started !== false)
    lines.push({ event: 'path', task: TASK, path: 'cheap', worktree: w.tree, branch: 'feat/answer-through-shift-bg' })
  if (options.journaled !== null)
    lines.push({ event: 'answer-brief', task: TASK, file: w.prompt, sha256: options.journaled ?? sha256(BRIEF), ts: '2026-10-09T09:00:00.000Z' })
  writeFileSync(w.journal, lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  return w
}

function deps(w: World, claude: string, io: { out: string[], err: string[] } = { out: [], err: [] }): ShiftDeps {
  return {
    cwd: w.root,
    claude,
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
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000758',
    run: runClaude,
    out: line => io.out.push(line),
    err: line => io.err.push(line),
  }
}

function notes(w: World): string[] {
  return readFileSync(w.journal, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as { event: string, note?: string }).filter(line => line.event === 'note').map(line => line.note!)
}

function answer(w: World, prompt: string = w.prompt, claude: string = w.stub, io?: { out: string[], err: string[] }): Promise<number> {
  return runShift([w.shift, '--answer', TASK, '--prompt', prompt], deps(w, claude, io))
}

describe('pnpm shift --answer', () => {
  it('runs one session in the card worktree with the prompt and records its pid and log', async () => {
    const w = world()
    expect(await answer(w)).toBe(0)
    expect(readFileSync(path.join(w.out, 'cwd'), 'utf8').trim()).toBe(w.tree)
    expect(readFileSync(path.join(w.out, 'stdin'), 'utf8')).toBe(BRIEF)
    expect(readFileSync(path.join(w.out, 'argv'), 'utf8').trim()).toBe('-p --session-id 00000000-0000-4000-8000-000000000758')
    expect(readFileSync(answerPidPath(w.shift, TASK), 'utf8').trim()).toBe(readFileSync(path.join(w.out, 'pid'), 'utf8').trim())
    expect(readFileSync(answerLogPath(w.shift, TASK), 'utf8')).toContain('stub claude ran')
    const [start, end, ...more] = notes(w)
    expect(more).toEqual([])
    expect(start).toContain(`answer session started: pid ${readFileSync(path.join(w.out, 'pid'), 'utf8').trim()}`)
    expect(end).toBe('answer session ended: exit 0, session 00000000-0000-4000-8000-000000000758')
  })

  it('refuses a task with no start line or a missing prompt', async () => {
    const io = { out: [] as string[], err: [] as string[] }
    const unstarted = world({ started: false })
    expect(await answer(unstarted, unstarted.prompt, unstarted.stub, io)).toBe(1)
    expect(io.err.join('\n')).toContain(`task #${TASK} has no task:start line`)
    const missing = world()
    expect(await answer(missing, path.join(missing.shift, `answer-${TASK}-2.md`), missing.stub, io)).toBe(1)
    expect(io.err.join('\n')).toContain('does not exist')
    for (const w of [unstarted, missing]) {
      expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
      expect(existsSync(answerPidPath(w.shift, TASK))).toBe(false)
      expect(notes(w)).toEqual([])
    }
  })

  it('refuses a prompt file outside the shift directory', async () => {
    const w = world()
    const outside = path.join(w.root, `answer-${TASK}.md`)
    writeFileSync(outside, BRIEF)
    const linked = path.join(w.shift, `answer-${TASK}-link.md`)
    symlinkSync(outside, linked)
    const misnamed = path.join(w.shift, 'answer-7580.md')
    writeFileSync(misnamed, BRIEF)
    const io = { out: [] as string[], err: [] as string[] }
    for (const prompt of [outside, linked, misnamed])
      expect(await answer(w, prompt, w.stub, io)).toBe(1)
    expect(io.err.filter(line => line.includes('inside the shift directory'))).toHaveLength(3)
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
    expect(notes(w)).toEqual([])
  })

  it('refuses a brief whose sha256 differs from the journaled hash', async () => {
    const io = { out: [] as string[], err: [] as string[] }
    const changed = world({ journaled: sha256('the brief as approved\n') })
    expect(await answer(changed, changed.prompt, changed.stub, io)).toBe(1)
    expect(io.err.join('\n')).toContain(`not the journaled ${sha256('the brief as approved\n')}`)
    const unjournaled = world({ journaled: null })
    expect(await answer(unjournaled, unjournaled.prompt, unjournaled.stub, io)).toBe(1)
    expect(io.err.join('\n')).toContain('no event:answer-brief line')
    for (const w of [changed, unjournaled])
      expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
  })

  it('writes the pid and the log into the shift directory', async () => {
    const w = world()
    expect(await runShift([path.relative(w.root, w.shift), '--answer', `#${TASK}`, '--prompt', path.relative(w.root, w.prompt)], deps(w, w.stub))).toBe(0)
    expect(answerPidPath(w.shift, TASK)).toBe(path.join(w.shift, `answer-${TASK}.pid`))
    expect(answerLogPath(w.shift, TASK)).toBe(path.join(w.shift, `log-${TASK}-answer.txt`))
    expect(readFileSync(answerPidPath(w.shift, TASK), 'utf8')).toMatch(/^\d+\n$/)
    expect(readFileSync(answerLogPath(w.shift, TASK), 'utf8')).toContain('stub claude ran')
    expect(existsSync(path.join(w.tree, `answer-${TASK}.pid`))).toBe(false)
  })

  it('the answer session runs SHIFT_CLAUDE and its pid file names the claude process', async () => {
    const w = world()
    expect(await answer(w, w.prompt, `GH_TOKEN=$(echo token-of-E1i) ${w.stub} --permission-mode auto`)).toBe(0)
    expect(readFileSync(path.join(w.out, 'token'), 'utf8')).toBe('token-of-E1i')
    expect(readFileSync(path.join(w.out, 'argv'), 'utf8').trim()).toBe('--permission-mode auto -p --session-id 00000000-0000-4000-8000-000000000758')
    expect(readFileSync(answerPidPath(w.shift, TASK), 'utf8').trim()).toBe(readFileSync(path.join(w.out, 'pid'), 'utf8').trim())
  })

  it('refuses with no SHIFT_CLAUDE and spawns nothing', async () => {
    const w = world()
    const io = { out: [] as string[], err: [] as string[] }
    expect(await answer(w, w.prompt, ' ', io)).toBe(1)
    expect(io.err.join('\n')).toContain('SHIFT_CLAUDE is not set')
    expect(existsSync(answerPidPath(w.shift, TASK))).toBe(false)
  })
})
