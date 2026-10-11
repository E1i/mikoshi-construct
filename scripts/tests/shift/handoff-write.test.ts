import type { HandoffState } from '../../shift/handoff-write.js'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS, HANDOFF_LIMIT, runHandoffCheck, STATE_LABELS } from '../../ghosts/handoff-check.js'
import { nextArchive, OWNER_BOUNDARIES, runHandoffWrite, sessionHandoffOf, stateLines, withPrev, withState } from '../../shift/handoff-write.js'
import { statusOf } from '../../shift/relaunch.js'

const roots: string[] = []
const UNBOUNDED_OWNER_STATUSES = [
  'STATUS: OWNER',
  'STATUS: OWNER — review changes',
  'STATUS: OWNER — boundary: red-ci',
  `STATUS: OWNER — boundary: ${OWNER_BOUNDARIES[0]}\n\nSTATUS: OWNER`,
  'STATUS: OWNER.',
  'STATUS: OWNER—boundary: x',
  'STATUS: OWNER\nSTATUS: n/a',
]
const DECISIONS = fileURLToPath(import.meta.url)
const PARKED = new Map<number, number[]>([[650, []], [652, [650]]])

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function draft(extra: Record<string, string> = {}): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.map(field => [field.label, field.id === 'decisions' ? DECISIONS : `${field.id} value`])), 'queue': '#650 → #652', 'in-flight': '#650 brief', ...extra }
  return `# Handoff\n\n## STOP — window 2\n${Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE\n`
}

function world(): { dir: string, handoff: string, draft: string } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'handoff-write-')))
  roots.push(dir)
  return { dir, handoff: path.join(dir, 'handoff.md'), draft: path.join(dir, 'draft.md') }
}

const BUS_STATE: HandoffState = {
  ready: [{ card: '650', lane: 'lane-1', reason: null }, { card: '652', lane: 'lane-1', reason: null }],
  blocked: [{ card: '653', lane: 'lane-2', reason: 'waits question' }],
  lanes: [{ lane: 'lane-1', card: 648, state: 'running', since: null }, { lane: 'lane-2', card: null, state: null, since: null }],
  execution: [{ card: 648, pr: null, stage: 'writing', since: null, review: null, markers: [] }, { card: 640, pr: 701, stage: 'awaiting merge', since: null, review: null, markers: [] }],
}

function write(args: string[], handoffDir?: string, sessionHandoff: string | null = path.resolve(handoffDir ?? '/nowhere', args[0] ?? ''), state: HandoffState | null = null): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runHandoffWrite(args, {
    cwd: '/nowhere',
    handoffDir,
    sessionHandoff,
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: dir => mkdirSync(dir, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: () => PARKED,
    state: () => state,
    home: '/home/x',
    out: line => out.push(line),
    err: line => err.push(line),
  })
  return { code, out, err }
}

describe('handoff:write', () => {
  it('measures the limit as handoff:check does', () => {
    const { handoff, draft: file } = world()
    const bloated = draft({ 'not done': 'é'.repeat(HANDOFF_LIMIT / 2 - 100) })
    expect(bloated.length).toBeLessThan(HANDOFF_LIMIT)
    expect(Buffer.byteLength(bloated)).toBeGreaterThan(HANDOFF_LIMIT)
    writeFileSync(file, bloated)
    const refused = write([handoff, file])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('bytes over the limit of 6000')
    const checked: string[] = []
    const code = runHandoffCheck([file, '--parking', '/p'], { exists: existsSync, read: f => readFileSync(f, 'utf8'), parked: () => PARKED, home: '/home/x', out: () => {}, err: line => checked.push(line) })
    expect(code).toBe(1)
    expect(checked.join('\n')).toContain('bytes over the limit of 6000')
    writeFileSync(file, draft())
    const ok = write([handoff, file])
    expect(ok.code).toBe(0)
    expect(ok.out[0]).toContain(`${Buffer.byteLength(readFileSync(handoff, 'utf8'))} bytes`)
  })

  it('archives the old handoff and writes prev', () => {
    const { dir, handoff, draft: file } = world()
    const old = '# Handoff\n\n## STOP — window 1\nold\n\n## STOP — window 0\nolder\n'
    writeFileSync(handoff, old)
    writeFileSync(file, draft())
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(path.join(dir, 'archive', '0001.md'), 'utf8')).toBe(old)
    const written = readFileSync(handoff, 'utf8')
    expect(written.split('\n').slice(2, 4)).toEqual(['## STOP — window 2', 'prev: archive/0001.md'])
    writeFileSync(file, draft({ prev: 'archive/0009.md' }))
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(path.join(dir, 'archive', '0002.md'), 'utf8')).toBe(written)
    expect(readFileSync(handoff, 'utf8')).toContain('prev: archive/0002.md\n')
    expect(readFileSync(handoff, 'utf8')).not.toContain('0009')
  })

  it('writes prev: none for the first handoff and archives nothing', () => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(file, draft())
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('prev: none\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('refuses a draft that fails the check, archiving nothing and leaving the handoff unchanged', () => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(handoff, 'old\n')
    for (const bad of [draft({ queue: '#650 then the rest' }), draft({ 'not done': 'x'.repeat(HANDOFF_LIMIT) }), `${draft()}\n## STOP — again\n`]) {
      writeFileSync(file, bad)
      const result = write([handoff, file])
      expect(result.code).toBe(1)
      expect(result.err.at(-1)).toContain('nothing archived')
    }
    expect(readFileSync(handoff, 'utf8')).toBe('old\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('writes into the directory CONSTRUCT_HANDOFF_DIR names, with the archive and prev: there', () => {
    const { dir, draft: file } = world()
    const ghostDir = path.join(dir, 'ghost-handoff')
    mkdirSync(ghostDir)
    writeFileSync(path.join(ghostDir, 'handoff.md'), 'old\n')
    writeFileSync(file, draft())
    expect(write(['handoff.md', file], ghostDir).code).toBe(0)
    expect(readFileSync(path.join(ghostDir, 'archive', '0001.md'), 'utf8')).toBe('old\n')
    expect(readFileSync(path.join(ghostDir, 'handoff.md'), 'utf8')).toContain('prev: archive/0001.md\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('refuses a new handoff file that is not the session handoff, writes the session handoff and an existing file', () => {
    const { dir, handoff, draft: file } = world()
    const session = path.join(dir, 'mikoshi.md')
    writeFileSync(file, draft())
    const refused = write([handoff, file], undefined, session)
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain(session)
    expect(existsSync(handoff)).toBe(false)
    expect(write([session, file], undefined, session).code).toBe(0)
    expect(existsSync(session)).toBe(true)
    writeFileSync(handoff, 'old\n')
    expect(write([handoff, file], undefined, session).code).toBe(0)
  })

  it('lets a card session with no CONSTRUCT_HANDOFF create its task handoff', () => {
    const { dir, draft: file } = world()
    const task = path.join(dir, '866-handoff.md')
    writeFileSync(file, draft())
    const session = sessionHandoffOf({ CONSTRUCT_CARD: '866', CONSTRUCT_HANDOFF_DIR: dir }, '/home')
    expect(session).toBeNull()
    expect(write([task, file], undefined, session).code).toBe(0)
    expect(existsSync(task)).toBe(true)
  })

  it('lets a card session that inherited the Operator CONSTRUCT_HANDOFF create its task handoff', () => {
    const { dir, draft: file } = world()
    const operator = path.join(dir, 'operator.md')
    const task = path.join(dir, '866-handoff.md')
    writeFileSync(file, draft())
    const session = sessionHandoffOf({ CONSTRUCT_CARD: '866', CONSTRUCT_HANDOFF: operator, CONSTRUCT_HANDOFF_DIR: dir }, '/home')
    expect(session).toBeNull()
    expect(write([task, file], undefined, session).code).toBe(0)
    expect(existsSync(task)).toBe(true)
    expect(existsSync(operator)).toBe(false)
  })

  it.each([
    ['unset variables', {}, '/home/.construct/handoff/miko.md'],
    ['empty variables', { CONSTRUCT_HANDOFF: '', CONSTRUCT_HANDOFF_DIR: '', CONSTRUCT_CARD: '' }, '/home/.construct/handoff/miko.md'],
    ['a handoff dir', { CONSTRUCT_HANDOFF_DIR: '/d' }, '/d/miko.md'],
    ['CONSTRUCT_HANDOFF over the dir', { CONSTRUCT_HANDOFF: '/r/h.md', CONSTRUCT_HANDOFF_DIR: '/d' }, '/r/h.md'],
    ['a card session with an inherited CONSTRUCT_HANDOFF', { CONSTRUCT_HANDOFF: '/r/operator.md', CONSTRUCT_HANDOFF_DIR: '/d', CONSTRUCT_CARD: '1' }, null],
    ['a card session with no CONSTRUCT_HANDOFF', { CONSTRUCT_CARD: '866', CONSTRUCT_HANDOFF: '' }, null],
  ] as const)('reads the session handoff from %s', (_, env, expected) => {
    expect(sessionHandoffOf(env, '/home')).toBe(expected)
  })

  it('numbers the archive after the highest archive already there', () => {
    expect(nextArchive([])).toBe('0001.md')
    expect(nextArchive(['0001.md', '0007.md', 'notes.md'])).toBe('0008.md')
  })

  it('puts prev right under the STOP heading and drops any prev the draft carried', () => {
    expect(withPrev('# H\n## STOP\nprev: x\nqueue: #1', 'archive/0003.md')).toBe('# H\n## STOP\nprev: archive/0003.md\nqueue: #1')
  })

  it.each(UNBOUNDED_OWNER_STATUSES)('reads the refused draft %j as OWNER, as relaunch does', (status) => {
    expect(statusOf(draft().replace('STATUS: CONTINUE', status))).toBe('OWNER')
  })

  it.each(UNBOUNDED_OWNER_STATUSES)('refuses STATUS: OWNER with no boundary from the list, archiving nothing and naming the list: %j', (status) => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(handoff, 'old\n')
    writeFileSync(file, draft().replace('STATUS: CONTINUE', status))
    const result = write([handoff, file])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain(OWNER_BOUNDARIES.join(', '))
    expect(result.err.at(-1)).toContain('nothing archived')
    expect(readFileSync(handoff, 'utf8')).toBe('old\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('writes STATUS: OWNER that names a boundary from the list, and leaves CONTINUE and DONE as they were', () => {
    for (const status of [...OWNER_BOUNDARIES.map(name => `STATUS: OWNER — boundary: ${name}`), 'STATUS: CONTINUE', 'STATUS: DONE']) {
      const { handoff, draft: file } = world()
      writeFileSync(file, draft().replace('STATUS: CONTINUE', status))
      expect(write([handoff, file]).code).toBe(0)
      expect(readFileSync(handoff, 'utf8')).toContain(`${status}\n`)
    }
  })

  it('the in-flight and queue fields are generated from the bus state, not from the draft', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, draft({ 'queue': '#652', 'in-flight': '#999 brief', 'current card': '#1', 'owner waits': 'prose' }).replace('in-flight: #999 brief', 'in-flight: #999 brief\n#998 review PR #5'))
    const result = write([handoff, file], undefined, undefined, BUS_STATE)
    expect(result.err).toEqual([])
    expect(result.code).toBe(0)
    const written = readFileSync(handoff, 'utf8')
    expect(written).toContain('queue: #650 → #652\n')
    expect(written).toContain('in-flight:\n- #648 writing\n- #640 awaiting-merge PR #701\n')
    expect(written).toContain('current card: #648 lane-1 running\n')
    expect(written).toContain('owner waits: #653 waits question\n')
    expect(written).not.toMatch(/#99[89]|prose|current card: #1\n/)
    expect(written).toContain('stop reason: stop-reason value\n')
    expect(written).toContain('continue when: continue-when value\n')
    expect(result.out[0]).toContain(`${STATE_LABELS.join(', ')} from the bus state`)
  })

  it('writes none for every state field the bus holds nothing for, and lets a draft with no state fields pass', () => {
    const empty: HandoffState = { ready: [], blocked: [], lanes: [], execution: [] }
    expect(stateLines(empty)).toEqual(['current card: none', 'queue: none', 'in-flight: none', 'owner waits: none'])
    const { handoff, draft: file } = world()
    const bare = draft().split('\n').filter(line => !STATE_LABELS.some(label => line.startsWith(`${label}:`))).join('\n')
    writeFileSync(file, bare)
    expect(write([handoff, file]).code).toBe(1)
    expect(write([handoff, file], undefined, undefined, empty).code).toBe(0)
  })

  it('keeps the draft fields and says so when no bus state is read', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, draft())
    const result = write([handoff, file])
    expect(result.code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('queue: #650 → #652\n')
    expect(result.out[0]).toContain('no bus state read')
  })

  it('puts the generated fields under the STOP heading and keeps the labels that follow a dropped field', () => {
    expect(withState('# H\n## STOP\nqueue: #1\n#2\nstop reason: x\n', ['queue: #3'])).toBe('# H\n## STOP\nqueue: #3\nstop reason: x\n')
  })

  it('refuses a bad argv', () => {
    expect(write([]).code).toBe(2)
    expect(write(['a.md']).code).toBe(2)
    expect(write(['a.md', 'b.md', '--parking']).code).toBe(2)
  })
})
