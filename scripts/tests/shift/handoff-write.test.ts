import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS, HANDOFF_LIMIT, runHandoffCheck } from '../../ghosts/handoff-check.js'
import { nextArchive, OWNER_BOUNDARIES, runHandoffWrite, withPrev } from '../../shift/handoff-write.js'

const roots: string[] = []
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

function write(args: string[], handoffDir?: string): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runHandoffWrite(args, {
    cwd: '/nowhere',
    handoffDir,
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: dir => mkdirSync(dir, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: () => PARKED,
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

  it('numbers the archive after the highest archive already there', () => {
    expect(nextArchive([])).toBe('0001.md')
    expect(nextArchive(['0001.md', '0007.md', 'notes.md'])).toBe('0008.md')
  })

  it('puts prev right under the STOP heading and drops any prev the draft carried', () => {
    expect(withPrev('# H\n## STOP\nprev: x\nqueue: #1', 'archive/0003.md')).toBe('# H\n## STOP\nprev: archive/0003.md\nqueue: #1')
  })

  it('refuses STATUS: OWNER with no boundary from the list, archiving nothing and naming the list', () => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(handoff, 'old\n')
    for (const status of ['STATUS: OWNER', 'STATUS: OWNER — review changes', 'STATUS: OWNER — boundary: red-ci', `STATUS: OWNER — boundary: ${OWNER_BOUNDARIES[0]}\n\nSTATUS: OWNER`]) {
      writeFileSync(file, draft().replace('STATUS: CONTINUE', status))
      const result = write([handoff, file])
      expect(result.code).toBe(1)
      expect(result.err.join('\n')).toContain(OWNER_BOUNDARIES.join(', '))
      expect(result.err.at(-1)).toContain('nothing archived')
    }
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

  it('refuses a bad argv', () => {
    expect(write([]).code).toBe(2)
    expect(write(['a.md']).code).toBe(2)
    expect(write(['a.md', 'b.md', '--parking']).code).toBe(2)
  })
})
