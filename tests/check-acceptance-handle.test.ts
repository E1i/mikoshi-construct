import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalImplementText, sha256Hex } from '../scripts/ghosts/approval.js'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/check-acceptance.mjs')

const HEAD_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
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
    expect(Object.keys(handle)).toEqual(['argsPath', 'argsSha256', 'task', 'effort', 'agreedSha256', 'acceptance', 'witnessDigests', 'invariants', 'immutable', 'sketch', 'harness', 'hasDesign'])
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

  it('agreedSha256 is the sha256 of the whole canonical /implement text, Sketch: line included, with or without the /implement prefix', () => {
    const directory = scratch()
    const body = `Do the thing (handle).\nSketch: sketch/t @ ${HEAD_SHA}\n\nEffort: low — copy the pattern.\n\nAcceptance: the item holds — witness: \`true\`\n\nInvariants: the harness is green\n`
    const brief = path.join(directory, 'brief.md')
    const briefText = `# Brief: a title\n\nProse above the rule with the word implement in it.\n\n---\n\n/implement ${body}\n\n`
    writeFileSync(brief, briefText)
    const want = sha256Hex(canonicalImplementText(briefText)!)

    expect(buildHandle(briefText).agreedSha256).toBe(want)
    expect(buildHandle(`/implement ${body}`.replace(/\n+$/, '')).agreedSha256).toBe(want)
    expect(buildHandle(body).agreedSha256).toBe(want)
  })
})

describe('the witness mode extracts one command from the args file by its sha256', () => {
  function argsFile(): { file: string, actual: string, directory: string } {
    const directory = scratch()
    const file = path.join(directory, 'args.json')
    writeFileSync(file, JSON.stringify({ witnesses: [{ criterion: 'first', command: FIRST }, { criterion: 'second', command: SECOND }] }))
    return { file, actual: sha256(readFileSync(file)), directory }
  }

  it('witness prints, byte for byte, the command whose sha256 it was given', () => {
    const { file, actual } = argsFile()

    expect(runScript(['witness', '--args', file, '--sha256', actual, '--witness-sha256', sha256(SECOND)])).toEqual({ status: 0, stdout: SECOND, stderr: '' })
    expect(runScript(['witness', '--args', file, '--sha256', actual, '--witness-sha256', sha256(FIRST)]).stdout).toBe(FIRST)
  })

  it('witness refuses an args file whose sha256 is not the one the run was given', () => {
    const { file, actual } = argsFile()
    const other = 'f'.repeat(64)

    const wrong = runScript(['witness', '--args', file, '--sha256', other, '--witness-sha256', sha256(FIRST)])
    expect(wrong).toEqual({ status: 2, stdout: '', stderr: `${file} has sha256 ${actual}, and the run was given ${other}\n` })
  })

  it('witness refuses a witness sha256 the file does not hold with exit 2 and no output, never falling back to a position', () => {
    const { file, actual } = argsFile()

    const absent = runScript(['witness', '--args', file, '--sha256', actual, '--witness-sha256', sha256('echo three'), '--n', '1'])
    expect(absent.status).toBe(2)
    expect(absent.stdout).toBe('')
    expect(absent.stderr.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('witness refuses a malformed or missing hash, and an unreadable file', () => {
    const { file, actual, directory } = argsFile()

    for (const refused of [
      ['--args', file, '--sha256', actual, '--witness-sha256', 'nothex'],
      ['--args', file, '--sha256', actual],
      ['--args', file, '--sha256', 'nothex', '--witness-sha256', sha256(FIRST)],
      ['--args', path.join(directory, 'none.json'), '--sha256', actual, '--witness-sha256', sha256(FIRST)],
    ]) {
      const result = runScript(['witness', ...refused])
      expect(result.status, refused.join(' ')).toBe(2)
      expect(result.stdout, refused.join(' ')).toBe('')
      expect(result.stderr.split('\n').filter(Boolean), refused.join(' ')).toHaveLength(1)
    }
  })
})
