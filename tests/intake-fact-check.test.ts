import type { CheckFacts } from '../src/commands/intake/check.js'
import type { DraftCard } from '../src/commands/intake/draft.js'
import type { RepositoryFacts } from '../src/commands/intake/facts.js'
import type { IntakeOptions, IntakeResult } from '../src/commands/intake/index.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTOURS, decisionsOf, KINDS } from '../src/card/grammar.js'
import { runAttach } from '../src/commands/attach/index.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { checkDraft, COMPANION_REASON, COMPANION_TABLE, correctionText, DEFAULT_CONTOUR, invalidTestPatterns, publishedRootsOf } from '../src/commands/intake/check.js'
import { DirectoryFacts } from '../src/commands/intake/facts.js'
import { printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { listing } from './repository-listing.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const PUBLISHED = ['dist', 'templates']
const TASK = 'The intake should check every card against the repository before it is parked.'

const roots: string[] = []

type Remove = (root: string) => void

function removeEverything(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

function entriesLeftUnder(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
  }
  catch (error) {
    return [`(the root could not be listed: ${(error as Error).message})`]
  }
}

function removeOrNameLeftovers(root: string, remove: Remove = removeEverything): void {
  try {
    remove(root)
  }
  catch (error) {
    throw new Error(`${(error as Error).message}; left under ${root}: ${JSON.stringify(entriesLeftUnder(root))}`, { cause: error })
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    removeOrNameLeftovers(root)
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-fact-check-'))
  roots.push(root)
  return root
}

function put(root: string, relative: string, text = ''): void {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  writeFileSync(path.join(root, relative), text)
}

function repository(files: readonly string[]): string {
  const root = scratch()
  for (const file of files)
    put(root, file)
  return root
}

function card(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'check-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: TASK, witnesses: ['`pnpm run quality` is green'], ...fields }
}

function intake(cards: Record<string, unknown>[], options: Partial<IntakeOptions> & { taken?: string, root?: string }): { result: IntakeResult, parking: string, draftFile: string } {
  const root = options.root ?? scratch()
  const parking = path.join(root, 'parking')
  const draftFile = path.join(root, 'draft.json')
  writeFileSync(draftFile, JSON.stringify({ cards }))
  const result = runIntake({ draft: draftFile, parking, dir: root, dryRun: false, autoConfirm: true, readStdin: () => options.taken ?? '1', ...options, taken: '-' })
  return { result, parking, draftFile }
}

function written(result: IntakeResult, parking: string, id: number): string {
  if (result.status === 'refused')
    throw new Error(`refused: ${result.refusal} ${result.detail.join('; ')}`)
  return readFileSync(path.join(parking, `${id}.md`), 'utf8')
}

function printed(result: IntakeResult): string {
  const lines: string[] = []
  printIntake(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return lines.join('\n')
}

function draftCard(fields: Partial<DraftCard> = {}): DraftCard {
  return { name: 'check-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['scripts/a.ts'], task: TASK, witnesses: ['`test -f scripts/a.ts` passes'], depends: [], blocks: [], creates: [], unclear: [], ...fields }
}

function facts(overrides: Partial<CheckFacts> = {}): CheckFacts {
  return { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository: repositoryFacts(), ...overrides }
}

function repositoryFacts(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return { exists: () => true, pathsNamed: () => [], commandResolves: () => true, testsCovering: () => [], ...overrides }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function hashes(dir: string): Record<string, string> {
  return Object.fromEntries(listing(dir).map(entry => [entry, entry.endsWith('/') ? 'directory' : sha256(path.join(dir, entry))]))
}

describe('the scratch root removal', () => {
  it('names the entries left under the root when the removal fails', () => {
    const root = scratch()
    put(root, '.git/objects/ab/late-write')
    const notEmpty = (): void => {
      throw new Error(`ENOTEMPTY, Directory not empty: ${root}`)
    }
    expect(() => removeOrNameLeftovers(root, notEmpty)).toThrow(`ENOTEMPTY, Directory not empty: ${root}`)
    expect(() => removeOrNameLeftovers(root, notEmpty)).toThrow(path.join('.git', 'objects', 'ab', 'late-write'))
  })
})

describe('intake fact check', () => {
  it('corrects a wrong path, a taken number and an invalid contour, and a named number is never used', () => {
    const dir = repository(['src/commands/intake/index.ts', 'src/commands/sync/index.ts'])
    const { result, parking } = intake(
      [card({ number: 12, touches: ['src/command/sync/**'], contour: 'fast' }), card({ name: 'second-card', number: 40, touches: ['src/commands/intake/index.ts'] }), card({ name: 'third-card', touches: ['src/commands/intake/index.ts'] })],
      { dir, taken: '12' },
    )
    const first = written(result, parking, 13)
    const output = printed(result)
    for (const text of [
      'corrected: number — #12 → #13 — #12 is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake',
      'corrected: touches — src/command/sync/** → src/commands/sync/** — \'src/command/sync\' does not exist; \'src/commands/sync\' is the only path named \'sync\'',
      'corrected: contour — fast → ladder — \'fast\' is not one of cheap, ladder; ladder is the path with a brief and witnesses',
    ]) {
      expect(first).toContain(text)
      expect(output).toContain(text)
    }
    expect(first).toContain('who: window')
    expect(first).toContain(TASK)
    const second = written(result, parking, 14)
    expect(second).toContain('corrected: number — #40 → #14 — numbers are assigned by construct intake, the next free after every number taken; a named number is never used')
    expect(printed(result)).toContain('1 field corrected against the repository and the grammar; accepted in advance by --auto-confirm, and recorded in the journal.')
    const third = written(result, parking, 15)
    expect(third).not.toContain('corrected: number')
    expect(third).not.toContain('corrected:')
  })

  it('removes a merged depends, keeps a parked one and marks an unknown one unclear', () => {
    const root = scratch()
    put(root, 'parking/13.md', '')
    const dir = repository(['src/a.ts'])
    const { result, parking } = intake([card({ depends: ['#7', '#13', '#78', '#900'], blocks: ['#7'] })], { root, dir, cardStates: () => new Map([['7', 'merged']]), taken: '12' })
    const text = written(result, parking, 14)
    const output = printed(result)
    expect(output).toContain('corrected: depends — #7 → (removed) — already merged')
    expect(output).toContain('corrected: blocks — #7 → (removed) — already merged')
    expect(output).not.toMatch(/corrected: depends — #(13|78|900)/)
    expect(text).toContain('unclear: depends — \'#900\' is neither a parked card, done nor merged in the journal')
    expect(text).toContain('unclear: depends — \'#78\' is neither a parked card, done nor merged in the journal')
    expect(text).not.toContain('unclear: depends — \'#13\'')
    expect(text).toMatch(/^card: #14 \S+ \[.*\] · depends #13, #78, #900 · blocks —$/m)
  })

  it('marks a missing touch unclear when no single path is named like it, and accepts one listed under creates', () => {
    const dir = repository(['src/a/util.ts', 'tests/b/util.ts', 'src/commands/intake/index.ts'])
    const { result, parking } = intake([
      card({ touches: ['src/new/feature.ts', 'src/commands/intake/index.ts'], creates: ['src/new/feature.ts', 'src/commands/intake/index.ts'] }),
      card({ name: 'second-card', touches: ['src/new/feature.ts', 'lib/util.ts', 'src/commands/intake/index.ts'], creates: ['src/new/feature.ts'] }),
    ], { dir })
    expect(printed(result)).toContain('corrected: creates — src/commands/intake/index.ts → (exists, not new) — src/commands/intake/index.ts already exists')
    const second = written(result, parking, 3)
    expect(second).toContain('unclear: touches — \'lib/util.ts\' does not exist and 2 paths: src/a/util.ts, tests/b/util.ts are named \'util.ts\'; list it under creates if the change makes it')
    expect(second).not.toMatch(/(un)?clear(ed)?: (touches|creates) — .*feature\.ts/)
    expect(second).toContain('touches: src/new/feature.ts, lib/util.ts, src/commands/intake/index.ts')
  })

  it('flags a witness that names no command or a command that does not resolve', () => {
    const repo = repositoryFacts({ commandResolves: word => word === 'pnpm' })
    const [checked] = checkDraft([draftCard({ witnesses: ['it works', '`nosuchtool --flag` fails', '`pnpm run quality` passes', '`   ` nothing'] })], [2], facts({ repository: repo }))
    expect(checked!.unclear.map(entry => entry.reason)).toEqual([
      '\'it works\' names no command; a witness is run by a command',
      '\'nosuchtool\' is not on PATH and is no file of the repository',
      '\'`   ` nothing\' names no command; a witness is run by a command',
    ])
    expect(checked!.corrections).toEqual([])
    expect(checked!.witnesses).toEqual(['it works', '`nosuchtool --flag` fails', '`pnpm run quality` passes', '`   ` nothing'])
  })

  it('a witness that names origin/main is refused at intake', () => {
    const repo = repositoryFacts({ commandResolves: word => word === 'test' || word === 'git' })
    const witnesses = ['`test -f a.txt` exits 0', '`git diff --quiet origin/main` exits 0']
    const [checked] = checkDraft([draftCard({ witnesses })], [2], facts({ repository: repo }))
    expect(checked!.unclear.map(entry => entry.reason)).toEqual([
      'witness "`git diff --quiet origin/main` exits 0" names origin/main, which moves while the run goes; compare with HEAD, which the launcher pins at the base',
    ])
  })

  it('the real intake refuses a witness that fails bash -n, with no substituted check', () => {
    const witness = '`echo \'unterminated` exits 0'
    const dir = repository(['src/a.ts'])
    const { result, parking } = intake([card({ witnesses: [witness] })], { dir })
    const parked = written(result, parking, 2)
    expect(parked).toMatch(/^unclear: witnesses — witness "`echo 'unterminated` exits 0" fails bash -n: .*unexpected EOF/m)
    expect(parked).toMatch(/^who: window$/m)
    const { status, parked: admittedFile } = admitParked(dir, 'src/a.ts', witness)
    expect(status).toBe('admitted')
    expect(readFileSync(admittedFile, 'utf8')).toMatch(/^unclear: witnesses — witness "`echo 'unterminated` exits 0" fails bash -n: .*unexpected EOF/m)
  })

  it('the real intake admits a witness that passes bash -n', () => {
    const witness = '`test -f \'src/a.ts\'` exits 0'
    const dir = repository(['src/a.ts'])
    const { result, parking } = intake([card({ witnesses: [witness] })], { dir })
    expect(written(result, parking, 2)).not.toContain('unclear:')
    const { status, parked } = admitParked(dir, 'src/a.ts', witness)
    expect(status).toBe('admitted')
    expect(readFileSync(parked, 'utf8')).not.toContain('unclear:')
  })

  it('a witness written as prose is refused', () => {
    const witness = 'empty directory → `pnpm dev init --yes --preset node-backend` → `pnpm install` → `pnpm run quality` is green, output in the PR body'
    const [checked] = checkDraft([draftCard({ witnesses: [witness, '`pnpm run quality` is green'] })], [2], facts())
    expect(checked!.unclear.map(entry => entry.reason)).toEqual([`witness "${witness}" is written as prose: '→' is a step no command runs; a witness is a command and its exit`])
  })

  function outside(witness: string, named: string): string {
    return `witness "${witness}" names ${named}, a path outside the worktree the witness runs in; the tree under test cannot change it, so the witness cannot be red on the base`
  }

  function headIndependent(witness: string): string {
    return `witness "${witness}" reads nothing the tree under test can change; its result does not depend on the head`
  }

  it('a witness naming a path outside the repository is refused', () => {
    const witnesses = ['`test -f ~/.construct/probes/report.md` exits 0', '`grep -q done $HOME/notes.md` exits 0', '`grep -q done /etc/hosts` exits 0', '`grep -q done src/a.ts >/dev/null` exits 0']
    const [checked] = checkDraft([draftCard({ witnesses })], [2], facts({ repository: repositoryFacts({ exists: relative => relative === 'src/a.ts' || relative === 'scripts/a.ts' }) }))
    expect(checked!.unclear.map(entry => entry.reason)).toEqual([
      outside(witnesses[0]!, '~/.construct/probes/report.md'),
      headIndependent(witnesses[0]!),
      outside(witnesses[1]!, '$HOME/notes.md'),
      headIndependent(witnesses[1]!),
      outside(witnesses[2]!, '/etc/hosts'),
      headIndependent(witnesses[2]!),
    ])
  })

  it('an absolute path into the checkout intake reads is refused at intake and at admit alike, since the witness runs in another worktree', () => {
    const dir = repository(['src/a.ts'])
    const absolute = path.join(dir, 'src/a.ts')
    const witness = `\`grep -q done ${absolute}\` exits 0`
    const reason = `unclear: witnesses — ${outside(witness, absolute)}`
    const { result, parking } = intake([card({ witnesses: [witness] })], { dir })
    expect(written(result, parking, 2)).toContain(reason)
    const { status, parked } = admitParked(dir, 'src/a.ts', witness)
    expect(status).toBe('admitted')
    expect(readFileSync(parked, 'utf8')).toContain(reason)
  })

  it('a test-name pattern or an output redirect target that looks absolute is no path the witness reads', () => {
    const repo = repositoryFacts({ exists: relative => relative === 'scripts/a.ts' || relative === 'tests/api.test.ts' })
    const witnesses = ['`pnpm exec vitest run tests/api.test.ts -t \'/api/users\'` exits 0', '`pnpm exec vitest run tests/api.test.ts --testNamePattern=/api/users` exits 0', '`grep -c done tests/api.test.ts > /tmp/out` exits 0', '`grep -c done tests/api.test.ts 2>/tmp/err` exits 0']
    const [checked] = checkDraft([draftCard({ witnesses })], [2], facts({ repository: repo }))
    expect(checked!.unclear).toEqual([])
  })

  it('a witness that does not depend on the head is refused', () => {
    const repo = repositoryFacts({ exists: relative => ['src/a.ts', 'scripts/a.ts', 'scripts/run.sh'].includes(relative) })
    const refused = ['`true` exits 0', '`echo done` exits 0', '`node -v` exits 0', '`git --version` exits 0', '`pnpm --version` exits 0']
    const kept = ['`test -f src/a.ts` exits 0', '`./scripts/run.sh` exits 0', '`pnpm run quality` is green', '`git diff --quiet HEAD` exits 0', '`tsc` exits 0']
    const [checked] = checkDraft([draftCard({ witnesses: [...refused, ...kept] })], [2], facts({ repository: repo }))
    expect(checked!.unclear.map(entry => entry.reason)).toEqual(refused.map(headIndependent))
  })

  it('the real admit refuses a witness that reads a home file', () => {
    const dir = repository(['src/a.ts'])
    const witness = '`test -f ~/.construct/probes/report.md` exits 0'
    const { status, parked } = admitParked(dir, 'src/a.ts', witness)
    expect(status).toBe('admitted')
    expect(readFileSync(parked, 'utf8')).toContain(`unclear: witnesses — ${outside(witness, '~/.construct/probes/report.md')}`)
  })

  it('checks every backticked command of a witness and names the second one when it does not resolve', () => {
    const repo = repositoryFacts({ commandResolves: word => word === 'pnpm' })
    const [checked] = checkDraft([draftCard({ witnesses: ['`pnpm run quality` passes, then `nosuchtool --flag` fails'] })], [2], facts({ repository: repo }))
    expect(checked!.unclear.map(entry => entry.reason)).toEqual(['\'nosuchtool\' is not on PATH and is no file of the repository'])
  })

  it('gives a witness running `/usr/bin/env test` no unclear line', () => {
    const dir = repository(['src/a.ts'])
    const [checked] = checkDraft([draftCard({ witnesses: ['`/usr/bin/env test -f src/a.ts` exits 0'] })], [2], facts({ repository: new DirectoryFacts(dir, '') }))
    expect(checked!.unclear).toEqual([])
  })

  it('corrects a decision the kind does not take through decisionsOf, and a contour outside the grammar', () => {
    for (const kind of KINDS) {
      const [default_] = decisionsOf(kind)
      for (const decision of decisionsOf(kind))
        expect(checkDraft([draftCard({ kind, decision })], [2], facts())[0]!.corrections).toEqual([])
      const [corrected] = checkDraft([draftCard({ kind, decision: 'nonsense' })], [2], facts())
      expect(corrected!.decision).toBe(default_)
      expect(corrected!.corrections).toEqual([{ field: 'decision', was: 'nonsense', now: default_, reason: `kind ${kind} takes decision ${decisionsOf(kind).join(' or ')}, not nonsense` }])
    }
    expect(checkDraft([draftCard({ kind: 'probe', decision: 'owner' })], [2], facts())[0]!.decision).toBe('none')
    expect(checkDraft([draftCard({ kind: 'implement', decision: 'none' })], [2], facts())[0]!.decision).toBe('owner')
    for (const contour of CONTOURS)
      expect(checkDraft([draftCard({ contour })], [2], facts())[0]!.corrections).toEqual([])
    expect(checkDraft([draftCard({ contour: 'fast' })], [2], facts())[0]!.contour).toBe(DEFAULT_CONTOUR)
    const untouched = checkDraft([draftCard({ kind: 'fix', decision: 'owner' })], [2], facts())[0]!
    expect(untouched.decision).toBe('owner')
    expect(untouched.corrections).toEqual([])
  })

  it('refuses a kind outside the grammar with nothing parked', () => {
    const dir = repository(['src/a.ts'])
    const { result, parking } = intake([card({ kind: 'fix' })], { dir })
    expect(result).toMatchObject({ status: 'refused', refusal: 'invalid' })
    expect(() => statSync(parking)).toThrow()
  })

  it('checks a repository reached through attach and writes nothing inside it', async () => {
    const dir = scratch()
    cpSync(EXISTING_MONOREPO, dir, { recursive: true })
    put(dir, 'src/zebra-quokka.ts')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir })
    await runAttach(createUi(resolveTheme({ plain: true }), silentWriter), { dir, harness: 'true', requiredCheck: 'gate', yes: true })
    const before = hashes(dir)
    const { result, parking } = intake([card({ touches: ['lib/zebra-quokka.ts', '.claude/**'] })], { dir })
    const text = written(result, parking, 2)
    expect(text).toContain('corrected: touches — lib/zebra-quokka.ts → src/zebra-quokka.ts')
    expect(text).not.toContain('corrected: touches — .claude')
    expect(hashes(dir)).toEqual(before)
    expect(path.relative(dir, parking).startsWith('..')).toBe(true)
    const dry = intake([card({ touches: ['lib/zebra-quokka.ts'] })], { dir, dryRun: true })
    expect(printed(dry.result)).toContain('corrected: touches — lib/zebra-quokka.ts → src/zebra-quokka.ts')
    expect(hashes(dir)).toEqual(before)
  })

  it('keeps every original value in the card and never edits the draft file', () => {
    const dir = repository(['src/commands/sync/index.ts'])
    const draftBefore = JSON.stringify({ cards: [card({ number: 12, touches: ['src/command/sync/**'], contour: 'fast', depends: ['#7'] })] })
    const { result, parking, draftFile } = intake(JSON.parse(draftBefore).cards, { dir, cardStates: () => new Map([['7', 'merged']]), taken: '12' })
    const text = written(result, parking, 13)
    for (const was of ['#12', 'src/command/sync/**', 'fast', '#7'])
      expect(text).toContain(`${was} →`)
    expect(text).toContain(TASK)
    expect(readFileSync(draftFile, 'utf8')).toBe(draftBefore)
  })

  it('adds the script companions the repository has to a drafted card that touches package.json, and never twice', () => {
    const [checked] = checkDraft([draftCard({ touches: ['package.json', 'tests/harness-membership.test.ts'] })], [2], facts())
    expect(checked!.touches).toEqual(['package.json', 'tests/harness-membership.test.ts', 'CONTRIBUTING.md'])
    expect(checked!.corrections).toMatchObject([{ field: 'touches', was: '(absent)', now: 'CONTRIBUTING.md' }])
    expect(checkDraft([draftCard({ touches: ['packages/a/package.json'] })], [2], facts())[0]!.touches).toEqual(['packages/a/package.json'])
    const elsewhere = repositoryFacts({ exists: relative => relative === 'package.json' })
    expect(checkDraft([draftCard({ touches: ['package.json'] })], [2], facts({ repository: elsewhere }))[0]!.touches).toEqual(['package.json'])
  })

  it('adds no companion where the repository has no harness membership test', () => {
    const foreign = repositoryFacts({ exists: relative => relative === 'package.json' || relative === 'CONTRIBUTING.md' })
    const [checked] = checkDraft([draftCard({ touches: ['package.json'] })], [2], facts({ repository: foreign }))
    expect(checked!.touches).toEqual(['package.json'])
    expect(checked!.corrections).toEqual([])
  })

  it('adds the test of a src/ module the card touches without its test, as a correction', () => {
    const dir = repository(['src/commands/intake/check.ts', 'tests/commands/intake/check.test.ts', 'tests/other.test.ts'])
    const [checked] = checkDraft([draftCard({ touches: ['src/commands/intake/check.ts'] })], [2], facts({ repository: new DirectoryFacts(dir, '') }))
    expect(checked!.touches).toEqual(['src/commands/intake/check.ts', 'tests/commands/intake/check.test.ts'])
    expect(checked!.corrections).toEqual([{ field: 'touches', was: '(absent)', now: 'tests/commands/intake/check.test.ts', reason: COMPANION_REASON }])
  })

  const companionCases: Record<string, { repository: string[], touches: string[], added: string[] }> = {
    'the scripts manifest': { repository: ['package.json', 'CONTRIBUTING.md', 'tests/harness-membership.test.ts'], touches: ['package.json', 'tests/harness-membership.test.ts'], added: ['CONTRIBUTING.md'] },
    'the command definitions': { repository: ['src/program.ts', 'README.md', 'docs/cli.md', 'docs/guide/getting-started.md', 'tests/readme-commands.test.ts'], touches: ['src/program.ts', 'tests/**'], added: ['README.md', 'docs/cli.md', 'docs/guide/**'] },
    'published code': { repository: ['templates/base/a.md', '.changeset/config.json'], touches: ['templates/base/**'], added: ['.changeset/**'] },
    'source code': { repository: ['src/model/**', 'src/model/write.ts', 'tests/a.test.ts'], touches: ['src/model/**'], added: ['tests/**'] },
  }

  it('has one case for every row of the companion table, and no case without a row', () => {
    expect(Object.keys(companionCases).sort()).toEqual(COMPANION_TABLE.map(row => row.kind).sort())
  })

  for (const [kind, { repository: files, touches, added }] of Object.entries(companionCases)) {
    it(`adds the companions of ${kind} the card lacks, once, and none where the repository does not keep them`, () => {
      const dir = repository(files.filter(file => !file.endsWith('/**')))
      const kept = facts({ repository: new DirectoryFacts(dir, ''), published: PUBLISHED })
      const [checked] = checkDraft([draftCard({ touches })], [2], kept)
      expect(checked!.touches).toEqual([...touches, ...added])
      expect(checked!.corrections).toEqual(added.map(now => ({ field: 'touches', was: '(absent)', now, reason: COMPANION_REASON })))
      expect(checkDraft([draftCard({ touches: checked!.touches })], [2], kept)[0]!.corrections).toEqual([])
      const row = COMPANION_TABLE.find(entry => entry.kind === kind)!
      rmSync(path.join(dir, row.keptBy), { recursive: true, force: true })
      expect(checkDraft([draftCard({ touches })], [2], kept)[0]!.touches).toEqual(touches)
    })
  }

  function publishedRepository(manifest: Record<string, unknown> | null): string {
    const dir = repository(['.changeset/config.json', 'src/commands/intake/index.ts', 'scripts/board/next.ts', 'tests/a.test.ts'])
    if (manifest !== null)
      put(dir, 'package.json', JSON.stringify(manifest))
    return dir
  }

  function admitParked(dir: string, touches: string, witness?: string): { status: string, parked: string } {
    const parked = path.join(dir, 'parking', '80.md')
    const witnesses = witness === undefined ? '' : `\nWitnesses:\n- ${witness}\n`
    put(dir, 'parking/80.md', `card: #80 admit-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-80\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n${witnesses}`)
    const { status } = runAdmit({ file: parked, dir, dryRun: false, autoConfirm: true, parkingRoot: path.join(dir, 'parking') })
    return { status, parked }
  }

  function changesetCorrections(result: IntakeResult): string[] {
    if (result.status === 'refused')
      throw new Error(`refused: ${result.refusal} ${result.detail.join('; ')}`)
    return result.cards.flatMap(entry => entry.corrections.filter(correction => correction.now === '.changeset/**').map(correctionText))
  }

  it('a touch under src/commands gets the changeset companion', () => {
    const dir = publishedRepository({ name: 'published', files: PUBLISHED })
    const { result, parking } = intake([card({ touches: ['src/commands/intake/index.ts', 'tests/**'] })], { dir })
    expect(changesetCorrections(result)).toEqual([`touches — (absent) → .changeset/** — ${COMPANION_REASON}`])
    expect(written(result, parking, 2)).toContain('touches: src/commands/intake/index.ts, tests/**, .changeset/**')
  })

  it('a files entry written as ./dist/ names the published root dist', () => {
    expect(publishedRootsOf(JSON.stringify({ files: ['./dist/', 'templates'] }))).toEqual(['dist', 'templates'])
  })

  it('an admitted card that touches src gets the changeset companion when the files field names dist', () => {
    const dir = publishedRepository({ name: 'published', files: ['dist'] })
    const { status, parked } = admitParked(dir, 'src/commands/intake/index.ts, tests/**')
    expect(status).toBe('admitted')
    expect(readFileSync(parked, 'utf8')).toContain('touches: src/commands/intake/index.ts, tests/**, .changeset/**\n')
  })

  it('a package.json that cannot be read refuses intake and admit instead of throwing', () => {
    const dir = publishedRepository(null)
    mkdirSync(path.join(dir, 'package.json'))
    const { result } = intake([card({ touches: ['src/commands/intake/index.ts', 'tests/**'] })], { dir })
    expect(result).toMatchObject({ status: 'refused', refusal: 'unreadable' })
    expect(admitParked(dir, 'src/commands/intake/index.ts').status).toBe('refused')
  })

  it('a touch under scripts, which is not published, gets no changeset companion', () => {
    const dir = publishedRepository({ name: 'published', files: PUBLISHED })
    expect(changesetCorrections(intake([card({ touches: ['scripts/board/next.ts'] })], { dir }).result)).toEqual([])
  })

  it('a touch under src gets no changeset companion when package.json names no files', () => {
    for (const manifest of [null, { name: 'no-files-field' }]) {
      const dir = publishedRepository(manifest)
      expect(changesetCorrections(intake([card({ touches: ['src/commands/intake/index.ts', 'tests/**'] })], { dir }).result)).toEqual([])
    }
  })

  it('an unparseable package.json names no published files', () => {
    const dir = publishedRepository(null)
    put(dir, 'package.json', '{ "files": [')
    expect(publishedRootsOf('{ "files": [')).toBeUndefined()
    expect(changesetCorrections(intake([card({ touches: ['src/commands/intake/index.ts', 'tests/**'] })], { dir }).result)).toEqual([])
  })

  it('keeps who: shift on a corrected card with no unclear line', () => {
    const dir = repository(['src/commands/sync/index.ts'])
    const { result, parking } = intake([card({ who: 'shift', touches: ['src/command/sync/**'] })], { dir })
    const text = written(result, parking, 2)
    expect(text).toContain('corrected: touches — src/command/sync/** → src/commands/sync/**')
    expect(text).not.toContain('unclear:')
    expect(text).toMatch(/^who: shift$/m)
  })
})

describe('directoryFacts walk', () => {
  it('does not follow a symlinked directory and finds no candidate inside .git or node_modules', () => {
    const dir = repository(['src/real/target.ts', 'node_modules/pkg/target.ts', '.git/hooks/target.ts'])
    symlinkSync(dir, path.join(dir, 'src/loop'), 'dir')
    symlinkSync(path.join(dir, 'src'), path.join(dir, 'alias'), 'dir')
    const found = new DirectoryFacts(dir, '').pathsNamed('target.ts')
    expect(found).toEqual(['src/real/target.ts'])
  })

  it('resolves a relative path only to a file inside the repository, and an absolute path to any existing executable file', () => {
    const dir = repository(['scripts/run.sh', 'scripts/notes.txt'])
    chmodSync(path.join(dir, 'scripts/run.sh'), 0o755)
    const facts = new DirectoryFacts(dir, '')
    expect(facts.commandResolves('./scripts/run.sh')).toBe(true)
    expect(facts.commandResolves('scripts/missing.sh')).toBe(false)
    expect(facts.commandResolves('../scripts/run.sh')).toBe(false)
    expect(facts.commandResolves(path.join(dir, 'scripts/run.sh'))).toBe(true)
    expect(facts.commandResolves(path.join(dir, 'scripts/notes.txt'))).toBe(false)
    expect(facts.commandResolves(path.join(dir, 'scripts/missing.sh'))).toBe(false)
    expect(facts.commandResolves(path.join(dir, 'scripts'))).toBe(false)
  })

  it('gives a witness naming /usr/bin/env no unclear line and still marks a missing absolute path unclear', () => {
    const dir = repository(['src/a.ts'])
    const missing = path.join(dir, 'no/such/tool')
    const [checked] = checkDraft([draftCard({ witnesses: ['`/usr/bin/env test -f src/a.ts` passes', `\`${missing} --flag\` fails`] })], [2], facts({ repository: new DirectoryFacts(dir, '') }))
    expect(checked!.unclear.map(entry => entry.reason)).toEqual([`'${missing}' is not on PATH and is no file of the repository`])
  })
})

describe('witness -t patterns', () => {
  it('a witness whose -t is not a regex is refused', () => {
    const bad = draftCard({ witnesses: ['`pnpm exec vitest run tests/a.test.ts -t \'a named file against tests/** is no conflict\'` passes'] })
    const reasons = invalidTestPatterns([bad])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('Nothing to repeat')
    expect(reasons[0]).toContain('vitest run tests/a.test.ts')
  })

  it('accepts a -t that compiles, escaped or double-quoted', () => {
    const good = draftCard({ witnesses: ['`vitest -t \'tests/\\*\\*\'` passes', '`vitest -t "a (b)"` passes'] })
    expect(invalidTestPatterns([good])).toEqual([])
  })
})
