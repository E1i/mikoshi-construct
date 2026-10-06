import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalEvent, revokeEvent } from '../../ghosts/approval.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const CARD = 902
const OTHER_HASH = 'b'.repeat(64)

const created: string[] = []

function world(...args: string[]): string {
  const result = spawnSync('bash', [WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  if (args[0] === 'new')
    created.push(result.stdout.trim())
  return result.stdout.trim()
}

afterEach(() => {
  while (created.length > 0)
    world('clean', created.pop()!)
})

function approvedPath(w: string): string {
  return path.join(w, 'handoff', 'brief-g2.approved-sha256')
}

function journalPath(w: string): string {
  return path.join(w, 'handoff', 'ghosts.jsonl')
}

function sha256Of(w: string): string {
  return /sha256: ([0-9a-f]{64})/.exec(readFileSync(approvedPath(w), 'utf8'))![1]!
}

function signAs(w: string, approver: string): void {
  writeFileSync(approvedPath(w), readFileSync(approvedPath(w), 'utf8').replace(', world)', `, ${approver})`))
}

function journal(w: string, ...events: object[]): void {
  for (const event of events)
    appendFileSync(journalPath(w), `${JSON.stringify(event)}\n`)
}

function morseEvent(w: string, overrides: { card?: number, sha256?: string } = {}): object {
  return approvalEvent({ card: overrides.card ?? CARD, brief: path.join(w, 'handoff', 'brief-g2.md'), sha256: overrides.sha256 ?? sha256Of(w), sketch: 'none', risk: 'R3', reason: 'world fixture', forecast: { kind: 'forecast' }, ts: '2026-10-04T12:00:00.000Z' })
}

function launch(w: string, answer: string, args: string[] = []): { status: number | null, output: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, LAUNCH, '--tasks', path.join(w, 'tasks.json'), ...args], {
    input: `${answer}\n`,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(w, 'bin')}:${process.env.PATH}`, HOME: mkdtempSync(path.join(tmpdir(), 'ghosts-morse-home-')), CONSTRUCT_HANDOFF_DIR: path.join(w, 'handoff') },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function contractOf(output: string, id: string): string {
  return output.split('\n').find(line => line.startsWith('CONTRACT') && line.includes(`brief-${id}.md`)) ?? ''
}

function expectRefused(w: string, output: string, status: number | null, message: RegExp): void {
  expect(status).toBe(1)
  expect(output).toMatch(message)
  expect(output).not.toContain('task g1:')
  expect(output).not.toContain('DECISION:')
  world('check-untouched', w)
}

function expectOpened(output: string, status: number | null): void {
  expect(status).not.toBe(0)
  expect(output).toContain('DECISION: open 2 sessions')
  expect(contractOf(output, 'g1')).not.toContain('by morse')
}

describe('the launcher and an approval MORSE wrote', () => {
  it('launch accepts a morse approval line with its journal event and says so in the listing of g2 only', () => {
    const w = world('new', 'ok')
    signAs(w, 'morse')
    journal(w, morseEvent(w))
    const { status, output } = launch(w, 'no')
    expectOpened(output, status)
    expect(contractOf(output, 'g2')).toContain(`approved ${sha256Of(w).slice(0, 7)} by morse`)
    world('check-untouched', w)
  })

  it('launch refuses a morse approval line without its journal event', () => {
    const w = world('new', 'ok')
    signAs(w, 'morse')
    const { status, output } = launch(w, 'yes')
    expectRefused(w, output, status, /task g2: .*signed morse.*no approval event by morse for card #902/)
  })

  it('launch refuses a morse event for another card', () => {
    const w = world('new', 'ok')
    signAs(w, 'morse')
    journal(w, morseEvent(w, { card: 901 }))
    const { status, output } = launch(w, 'yes')
    expectRefused(w, output, status, /task g2: .*no approval event by morse for card #902/)
  })

  it('launch refuses a morse event for another hash', () => {
    const w = world('new', 'ok')
    signAs(w, 'morse')
    journal(w, morseEvent(w, { sha256: OTHER_HASH }))
    const { status, output } = launch(w, 'yes')
    expectRefused(w, output, status, /task g2: .*no approval event by morse for card #902/)
  })

  it('launch treats Morse in any case as morse', () => {
    const w = world('new', 'ok')
    signAs(w, 'MoRsE')
    const { status, output } = launch(w, 'yes')
    expectRefused(w, output, status, /task g2: .*no approval event by morse for card #902/)
  })

  it('launch leaves an owner approval line alone, with or without an event beside it', () => {
    const w = world('new', 'ok')
    journal(w, morseEvent(w, { card: 901 }))
    const { status, output } = launch(w, 'no')
    expectOpened(output, status)
    expect(contractOf(output, 'g2')).not.toContain('by morse')
    world('check-untouched', w)
  })
})

describe('the launcher and a revocation', () => {
  it('launch refuses a revoked owner approval', () => {
    const w = world('new', 'ok')
    journal(w, revokeEvent(sha256Of(w), CARD, '2026-10-04T12:00:00.000Z'))
    const { status, output } = launch(w, 'yes')
    expectRefused(w, output, status, /task g2: the approval [0-9a-f]{64} of card #902 was revoked/)
  })

  it('launch refuses a revoked morse approval', () => {
    const w = world('new', 'ok')
    signAs(w, 'morse')
    journal(w, morseEvent(w), revokeEvent(sha256Of(w), CARD, '2026-10-04T12:00:00.000Z'))
    const { status, output } = launch(w, 'yes')
    expectRefused(w, output, status, /task g2: the approval [0-9a-f]{64} of card #902 was revoked/)
  })

  it('a revoke for another hash does not stop the launch', () => {
    const w = world('new', 'ok')
    journal(w, revokeEvent(OTHER_HASH, CARD, '2026-10-04T12:00:00.000Z'))
    const { status, output } = launch(w, 'no')
    expectOpened(output, status)
  })

  it('a revoke for another card does not stop the launch', () => {
    const w = world('new', 'ok')
    journal(w, revokeEvent(sha256Of(w), 901, '2026-10-04T12:00:00.000Z'))
    const { status, output } = launch(w, 'no')
    expectOpened(output, status)
  })

  it('launch --revoke records the revocation in the journal and opens nothing', () => {
    const w = world('new', 'ok')
    const sha256 = sha256Of(w)
    const before = readFileSync(journalPath(w), 'utf8')
    const { status, output } = launch(w, 'yes', ['--revoke', sha256, '--card', `#${CARD}`])
    expect(status).toBe(0)
    expect(output).toContain(`card #${CARD}: approval ${sha256.slice(0, 7)} revoked in ${journalPath(w)}`)
    expect(output).not.toContain('DECISION:')
    const added = readFileSync(journalPath(w), 'utf8').slice(before.length).split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ event: 'revoke', sha256, card: CARD })
    expect(typeof added[0]!.ts).toBe('string')
    world('check-untouched', w)
  })

  it.each([
    { title: 'launch --revoke is refused without a card', args: (sha256: string) => ['--revoke', sha256] },
    { title: 'launch --revoke is refused with a short sha256', args: (sha256: string) => ['--revoke', sha256.slice(0, 7), '--card', String(CARD)] },
    { title: 'launch --revoke is refused with --fall', args: (sha256: string) => ['--revoke', sha256, '--fall', 'review-hole', '--card', String(CARD)] },
  ])('$title', ({ args }) => {
    const w = world('new', 'ok')
    const before = readFileSync(journalPath(w), 'utf8')
    const { status, output } = launch(w, 'yes', args(sha256Of(w)))
    expect(status).not.toBe(0)
    expect(output).toContain('usage: launch.ts')
    expect(readFileSync(journalPath(w), 'utf8')).toBe(before)
    world('check-untouched', w)
  })
})
