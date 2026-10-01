import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { hashBrief } from '../scripts/ghosts/hash.js'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/check-acceptance.mjs')

const FIRST = 'echo one'
const SECOND = 'grep -c "a b" f.txt\tx\ntrue'

const AGREED = [
  '/implement Keep the args in a file (handle).',
  '',
  'Effort: medium — one parser.',
  '',
  'Design:',
  '- D1. The design body, verbatim.',
  '',
  `Acceptance: the first item holds — witness: \`${FIRST}\`; the second item holds — witness: \`echo two\``,
  '',
  'Invariants: the harness is green',
  '',
  'Immutable: `src/`',
  '',
].join('\n')

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'args-handle-'))
  directories.push(directory)
  return directory
}

function sha256(content: string | Uint8Array): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function runScript(args: string[]): { status: number | null, stdout: string, stderr: string } {
  const child = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

function buildHandle(agreedText: string): Record<string, unknown> {
  const directory = scratch()
  const agreed = path.join(directory, 'agreed.txt')
  writeFileSync(agreed, agreedText)
  const result = runScript(['build', '--brief', agreed, '--out', path.join(directory, 'args.json')])
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe('the build writes the args file and prints a handle', () => {
  it('build --out writes the args file and prints the handle with its sha256', () => {
    const directory = scratch()
    const agreed = path.join(directory, 'agreed.txt')
    writeFileSync(agreed, AGREED)
    const out = path.join(directory, 'nested', 'implement-args.json')

    const result = runScript(['build', '--brief', agreed, '--out', out])
    const plain = runScript(['build', '--brief', agreed])

    expect(result.status).toBe(0)
    expect(existsSync(out)).toBe(true)
    const bytes = readFileSync(out)
    const file = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    const handle = JSON.parse(result.stdout) as Record<string, unknown>
    expect(plain.stdout).toBe(`${bytes.toString('utf8')}\n`)
    expect(Object.keys(handle)).toEqual(['argsPath', 'argsSha256', 'task', 'effort', 'agreedSha256', 'acceptance', 'witnessDigests', 'invariants', 'immutable', 'harness', 'hasDesign'])
    expect(handle.argsPath).toBe(out)
    expect(handle.argsSha256).toBe(sha256(bytes))
    expect(handle.hasDesign).toBe(true)
    expect(handle.agreedSha256).toBe(file.agreedSha256)
    expect(file.design).toBe('- D1. The design body, verbatim.')
    expect(file.witnesses).toEqual([{ criterion: 'the first item holds', command: FIRST }, { criterion: 'the second item holds', command: 'echo two' }])
    expect(file.witnessDigests).toEqual([{ criterion: 'the first item holds', sha256: sha256(FIRST) }, { criterion: 'the second item holds', sha256: sha256('echo two') }])
    expect(bytes.toString('utf8')).not.toContain('base64')
    expect('argsSha256' in file).toBe(false)
  })

  it('agreedSha256 is the sha256 pnpm ghosts:hash prints, with or without the /implement prefix', () => {
    const directory = scratch()
    const body = 'Do the thing (handle).\n\nEffort: low — copy the pattern.\n\nAcceptance: the item holds — witness: `true`\n\nInvariants: the harness is green\n'
    const brief = path.join(directory, 'brief.md')
    const briefText = `# Brief: a title\n\nProse above the rule with the word implement in it.\n\n---\n\n/implement ${body}\n\n`
    writeFileSync(brief, briefText)
    const want = hashBrief(brief)

    expect(buildHandle(briefText).agreedSha256).toBe(want)
    expect(buildHandle(`/implement ${body}`.replace(/\n+$/, '')).agreedSha256).toBe(want)
    expect(buildHandle(body).agreedSha256).toBe(want)
  })
})

describe('the witness mode extracts one command from the args file by its sha256', () => {
  it('witness prints one command byte for byte and refuses another sha256, a bad index or a missing file', () => {
    const directory = scratch()
    const file = path.join(directory, 'args.json')
    writeFileSync(file, JSON.stringify({ witnesses: [{ criterion: 'first', command: FIRST }, { criterion: 'second', command: SECOND }] }))
    const actual = sha256(readFileSync(file))
    const other = 'f'.repeat(64)

    expect(runScript(['witness', '--args', file, '--sha256', actual, '--n', '2'])).toEqual({ status: 0, stdout: SECOND, stderr: '' })
    expect(runScript(['witness', '--args', file, '--sha256', actual, '--n', '1']).stdout).toBe(FIRST)

    const wrong = runScript(['witness', '--args', file, '--sha256', other, '--n', '1'])
    expect(wrong.status).toBe(2)
    expect(wrong.stdout).toBe('')
    expect(wrong.stderr).toBe(`${file} has sha256 ${actual}, and the run was given ${other}\n`)

    for (const refused of [
      ['--args', file, '--sha256', actual, '--n', '0'],
      ['--args', file, '--sha256', actual, '--n', '3'],
      ['--args', file, '--sha256', actual, '--n', 'x'],
      ['--args', file, '--sha256', 'nothex', '--n', '1'],
      ['--args', path.join(directory, 'none.json'), '--sha256', actual, '--n', '1'],
    ]) {
      const result = runScript(['witness', ...refused])
      expect(result.status, refused.join(' ')).toBe(2)
      expect(result.stdout, refused.join(' ')).toBe('')
      expect(result.stderr.split('\n').filter(Boolean), refused.join(' ')).toHaveLength(1)
    }
  })
})
