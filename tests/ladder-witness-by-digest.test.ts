import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'
const SCRIPT = 'scripts/construct/check-acceptance.mjs'
const EXTRACTION = `node ${SCRIPT} witness `

const WITNESSES = [
  { criterion: 'criterion A holds', command: 'echo command-A' },
  { criterion: 'criterion B holds', command: 'echo command-B' },
  { criterion: 'criterion C holds', command: 'echo command-C' },
]

const AGREED = [
  'Extract each witness by its digest (by-digest).',
  '',
  'Effort: low — one lookup.',
  '',
  `Acceptance: ${WITNESSES.map(({ criterion, command }) => `${criterion} — witness: \`${command}\``).join('; ')}`,
  '',
  'Invariants: the harness is green',
  '',
].join('\n')

interface Handle {
  argsPath: string
  argsSha256: string
  acceptance: string[]
  witnessDigests: { criterion: string, sha256: string }[]
  [key: string]: unknown
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function builtHandle(): Handle {
  const directory = mkdtempSync(path.join(tmpdir(), 'witness-by-digest-'))
  directories.push(directory)
  const agreed = path.join(directory, 'agreed.txt')
  writeFileSync(agreed, AGREED)
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', agreed, '--out', path.join(directory, 'args.json')], { cwd: REPO_ROOT, encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(0)
  return JSON.parse(child.stdout) as Handle
}

function preflight(handle: Handle): Record<string, unknown> {
  return {
    passed: true,
    failureExcerpt: '',
    securityFinding: '',
    diffStat: '',
    testsWeakened: false,
    changedFiles: [],
    baseSha: '36f7abc9815cea1962b05bcf98bdcec193ba9fc5',
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256: handle.argsSha256,
    witnesses: [],
  }
}

async function verifyPrompt(handle: Handle): Promise<string> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  const prompts: string[] = []
  const agent = async (prompt: string, options: { agentType: string }): Promise<unknown> => {
    if (options.agentType === 'harness')
      prompts.push(prompt)
    if (options.agentType === 'implementer')
      return { status: 'done', summary: 's', files: ['a.ts'], harnessTail: 'ok', question: '' }
    if (prompts.length === 1)
      return preflight(handle)
    throw new Error('the verify prompt is all this test reads')
  }
  await new AsyncFunction('args', 'agent', 'log', 'phase', source)(handle, agent, () => {}, () => {}).catch(() => null)
  expect(prompts.length, 'the ladder reached its verify step').toBeGreaterThanOrEqual(2)
  return prompts[1] ?? ''
}

function extractionFor(prompt: string, criterion: string): string[] {
  const lines = prompt.split('\n')
  const line = lines[lines.indexOf(`- ${criterion}`) + 1] ?? ''
  expect(line.startsWith(EXTRACTION), `an extraction line follows ${criterion}`).toBe(true)
  return line.slice('node '.length, line.indexOf(' > ')).split(' ')
}

function extracted(prompt: string, criterion: string): string {
  const child = spawnSync(process.execPath, extractionFor(prompt, criterion), { cwd: REPO_ROOT, encoding: 'utf8' })
  return child.status === 0 ? child.stdout : `exit ${child.status}: ${child.stderr}`
}

function commandOf(criterion: string): string {
  return WITNESSES.find(witness => witness.criterion === criterion)?.command ?? ''
}

describe('the ladder extracts the witness it means, whatever the handle drops or reorders', () => {
  it('a handle that drops criterion B still extracts C\'s own command for C', async () => {
    const handle = builtHandle()
    const [a, , c] = WITNESSES.map(witness => witness.criterion)
    const prompt = await verifyPrompt({ ...handle, acceptance: [a, c] })

    expect(extracted(prompt, c)).toBe(commandOf(c))
    expect(extracted(prompt, a)).toBe(commandOf(a))
  })

  it('a handle that lists C before A extracts each criterion\'s own command', async () => {
    const handle = builtHandle()
    const [a, , c] = WITNESSES.map(witness => witness.criterion)
    const reordered = [c, a]
    const acceptanceOnly = await verifyPrompt({ ...handle, acceptance: reordered })
    const digestsToo = await verifyPrompt({
      ...handle,
      acceptance: reordered,
      witnessDigests: reordered.map(criterion => handle.witnessDigests.find(digest => digest.criterion === criterion)!),
    })

    for (const prompt of [acceptanceOnly, digestsToo]) {
      for (const criterion of reordered)
        expect(extracted(prompt, criterion), criterion).toBe(commandOf(criterion))
    }
  })

  it('a handle that matches the file extracts every witness as before', async () => {
    const handle = builtHandle()
    const prompt = await verifyPrompt(handle)

    expect(handle.acceptance).toEqual(WITNESSES.map(witness => witness.criterion))
    for (const { criterion, command } of WITNESSES)
      expect(extracted(prompt, criterion), criterion).toBe(command)
  })
})

describe('the ladder instructions name selection by the witness sha256', () => {
  const instructions = ['_claude/skills/implement/SKILL.md', '_claude/agents/harness.md']

  it.each(instructions)('%s and its .claude original select by --witness-sha256, never by --n, and are byte-identical', (source) => {
    const twin = readFileSync(path.join(REPO_ROOT, 'templates/ai/claude', source))
    const original = readFileSync(path.join(REPO_ROOT, source.replace('_claude/', '.claude/')))
    const text = twin.toString('utf8')

    expect(text).toContain('--witness-sha256')
    expect(text).not.toMatch(/--n\b/)
    expect(original.equals(twin)).toBe(true)
  })
})
