import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { approvedHashPath, checkApproval } from '../../ghosts/approval.js'
import { approvalLine, hashBrief } from '../../ghosts/hash.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const HASH = path.join(REPO_ROOT, 'scripts/ghosts/hash.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const NOW = new Date(2026, 9, 4, 12)
const HEAD_SHA = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const SOUND_TEXT = '/implement Print the name.\nSketch: none — independent implementation is the witness\n\nAcceptance: the name is printed — witness: `echo name`'
const BACKTICK_TEXT = '/implement Print the name.\nSketch: none — independent implementation is the witness\n\nAcceptance: the name is printed — witness: `echo `name``'

function worldDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ghosts-hash-'))
}

function briefWith(text: string): string {
  const brief = path.join(worldDir(), 'brief-t.md')
  writeFileSync(brief, `# head\n\nprose before the text\n\n---\n\n${text}\n`)
  return brief
}

function runHash(...args: string[]): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('approvalLine', () => {
  it('gives no hash for a brief whose witness holds a backtick, and names the first build error', () => {
    const brief = briefWith(BACKTICK_TEXT)

    expect(() => approvalLine(brief, NOW)).toThrow(/check-acceptance build exited 2 .*no hash is printed: backtick: the name is printed/)
  })

  it('prints the whole approval line for a sound brief, which checkApproval accepts', () => {
    const brief = briefWith(SOUND_TEXT)
    const line = approvalLine(brief, NOW)

    expect(line).toBe(`approved /implement text sha256: ${hashBrief(brief)} (2026-10-04, Eli; sketch none)`)
    writeFileSync(approvedHashPath(brief), `${line}\n`)
    expect(checkApproval(brief)).toEqual({ ok: true, text: SOUND_TEXT, sha256: hashBrief(brief) })
  })

  it('names only the first line the build printed on stderr', () => {
    const brief = briefWith(SOUND_TEXT)
    const runBuild = (): { status: number, stderr: string } => ({ status: 1, stderr: '\nfirst problem\nsecond problem\n' })

    expect(() => approvalLine(brief, NOW, runBuild)).toThrow(/: first problem$/)
  })

  it('names the sketch by its short sha when the brief starts from one', () => {
    const brief = briefWith(SOUND_TEXT.replace(/^Sketch: .*$/m, `Sketch: sketch/t @ ${HEAD_SHA}`))

    expect(approvalLine(brief, NOW)).toBe(`approved /implement text sha256: ${hashBrief(brief)} (2026-10-04, Eli; sketch ${HEAD_SHA.slice(0, 7)})`)
  })
})

describe('hashBrief', () => {
  it('hashes from the /implement line to the end of the file, its last line included', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    const text = '/implement Hash me.\n\nDesign:\n- the last line'
    writeFileSync(brief, `# head\n\nprose before the text\n\n---\n\n${text}`)

    const hash = hashBrief(brief)
    expect(hash).toBe(createHash('sha256').update(text).digest('hex'))
    expect(hash).not.toBe(createHash('sha256').update(text.slice(0, text.lastIndexOf('\n'))).digest('hex'))
  })

  it('refuses a brief with no /implement line, naming it', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    writeFileSync(brief, '# no marker\n')

    expect(() => hashBrief(brief)).toThrow(brief)
  })
})

describe('ghosts:hash from the command line', () => {
  it('prints nothing on stdout and exits 1 for a brief the build refuses', () => {
    const result = runHash(HASH, briefWith(BACKTICK_TEXT))

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('backtick: the name is printed')
  })

  it('prints the approval line when started through a symlink to the script', () => {
    const dir = worldDir()
    const brief = path.join(dir, 'brief.md')
    writeFileSync(brief, `${SOUND_TEXT}\n`)
    const link = path.join(dir, 'hash.ts')
    symlinkSync(HASH, link)

    const result = runHash(link, brief)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(new RegExp(`^approved /implement text sha256: ${hashBrief(brief)} \\(\\d{4}-\\d{2}-\\d{2}, Eli; sketch none\\)$`))
  })
})
