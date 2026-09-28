import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/check-acceptance.mjs')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-acceptance-verbatim-'))
  dirs.push(dir)
  return dir
}

function build(brief: string): { status: number | null, stdout: string, stderr: string } {
  const dir = scratch()
  writeFileSync(path.join(dir, 'construct.json'), JSON.stringify({ harness: { command: 'pnpm run quality' }, contracts: null }))
  writeFileSync(path.join(dir, 'brief.md'), brief)
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', path.join(dir, 'brief.md')], { cwd: dir, encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

const TAB = String.fromCharCode(9)
const NL = String.fromCharCode(10)

describe('the build keeps a witness command byte for byte', () => {
  it('preserves double spaces, a tab and a newline inside the backticks, while normalising the criterion', () => {
    const command = `grep -c "a  b" f.txt${TAB}x${NL}true`
    const result = build(`/implement Keep the witness byte for byte (#1).\n\nEffort: low.\n\nAcceptance: the  two  spaces item holds — witness: \`${command}\``)

    expect(result.status).toBe(0)
    const args = JSON.parse(result.stdout)
    expect(args.witnesses[0].command).toBe(command)
    expect(args.witnesses[0].criterion).toBe('the two spaces item holds')
  })
})

describe('the build prints witnessDigests in witness order', () => {
  it('carries the criterion, the base64 and the sha256 of the raw command, not the normalised one', () => {
    const c1 = 'test 1 -eq  1'
    const c2 = 'test 2 -eq 2'
    const result = build(`Task.\nAcceptance: the first item holds — witness: \`${c1}\`; the second item holds — witness: \`${c2}\``)

    expect(result.status).toBe(0)
    const args = JSON.parse(result.stdout)
    expect(args.witnessDigests).toEqual([
      { criterion: 'the first item holds', base64: Buffer.from(c1, 'utf8').toString('base64'), sha256: crypto.createHash('sha256').update(c1, 'utf8').digest('hex') },
      { criterion: 'the second item holds', base64: Buffer.from(c2, 'utf8').toString('base64'), sha256: crypto.createHash('sha256').update(c2, 'utf8').digest('hex') },
    ])
    expect(args.witnessDigests[0].sha256).not.toBe(crypto.createHash('sha256').update('test 1 -eq 1', 'utf8').digest('hex'))
  })
})

describe('a witness bash -n rejects is refused before any agent', () => {
  it('names the item, bash -n and bash\'s own message on stderr, and writes nothing on stdout', () => {
    const result = build('Task.\nAcceptance: the broken item holds — witness: `if then fi`')

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('the broken item holds')
    expect(result.stderr).toContain('bash -n')
    expect(result.stderr).toContain('syntax error near unexpected token')
  })

  it('builds a sound witness holding a single quote and a command substitution without running it', () => {
    const dir = scratch()
    const marker = path.join(dir, 'marker')
    const result = build(`Task.\nAcceptance: the sound item holds — witness: \`echo "it's" $(touch ${marker})\``)

    expect(result.status).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('the build puts the brief\'s Design section verbatim into the args as design', () => {
  it('carries the Design body verbatim when present', () => {
    const design = '- keep  it local\n- one owner'
    const result = build(`/implement Carry the Design (#1).\n\nEffort: low.\n\nDesign:\n${design}\n\nAcceptance: the design item holds — witness: \`true\``)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).design).toBe(design)
  })

  it('omits the design key entirely when the brief has no Design section', () => {
    const result = build('/implement No design here (#1).\n\nEffort: low.\n\nAcceptance: the item holds — witness: `true`')

    expect(result.status).toBe(0)
    expect(Object.keys(JSON.parse(result.stdout))).not.toContain('design')
  })

  it('carries the fixture a design verbatim', () => {
    const brief = path.resolve(import.meta.dirname, 'fixtures/briefs/a-label-in-prose-and-semicolon-in-witness.md')
    const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', brief], { encoding: 'utf8' })

    expect(JSON.parse(child.stdout).design).toBe('- a line that says Acceptance: inside prose is not a label')
  })

  it('omits the design key for fixtures d and f, which have none', () => {
    for (const name of ['d-immutable-tail-before-parenthesised-mutations', 'f-witness-marker-inside-a-command']) {
      const brief = path.resolve(import.meta.dirname, `fixtures/briefs/${name}.md`)
      const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', brief], { encoding: 'utf8' })

      expect(Object.keys(JSON.parse(child.stdout))).not.toContain('design')
    }
  })

  it('counts Design only at the start of a line', () => {
    const midLine = build('/implement Keep a mid-line label in its item (#1).\n\nEffort: low.\n\nAcceptance: the first item holds. Design: surprise — witness: `true`')

    expect(midLine.status).toBe(0)
    const midLineArgs = JSON.parse(midLine.stdout)
    expect(midLineArgs.witnesses).toEqual([{ criterion: 'the first item holds. Design: surprise', command: 'true' }])
    expect(Object.keys(midLineArgs)).not.toContain('design')

    const lineStart = build('/implement Carry the Design (#1).\n\nEffort: low.\n\nDesign:\n- one owner\n\nAcceptance: the item holds — witness: `true`')

    expect(JSON.parse(lineStart.stdout).design).toBe('- one owner')
  })
})
