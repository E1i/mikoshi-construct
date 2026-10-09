import type { CheckFacts } from '../src/commands/intake/check.js'
import type { DraftCard } from '../src/commands/intake/draft.js'
import type { RepositoryFacts } from '../src/commands/intake/facts.js'
import type { IntakeOptions, IntakeResult } from '../src/commands/intake/index.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTOURS, decisionsOf, KINDS } from '../src/card/grammar.js'
import { runAttach } from '../src/commands/attach/index.js'
import { checkDraft, COMPANION_REASON, COMPANION_TABLE, DEFAULT_CONTOUR, invalidTestPatterns } from '../src/commands/intake/check.js'
import { DirectoryFacts } from '../src/commands/intake/facts.js'
import { printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { listing } from './repository-listing.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const TASK = 'The intake should check every card against the repository before it is parked.'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
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
  const result = runIntake({ draft: draftFile, parking, dir: root, journal: path.join(root, 'ghosts.jsonl'), dryRun: false, autoConfirm: true, readStdin: () => options.taken ?? '1', ...options, taken: '-' })
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
  return { name: 'check-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['scripts/a.ts'], task: TASK, witnesses: ['`true` passes'], depends: [], blocks: [], creates: [], unclear: [], ...fields }
}

function facts(overrides: Partial<CheckFacts> = {}): CheckFacts {
  return { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository: repositoryFacts(), ...overrides }
}

function repositoryFacts(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return { exists: () => true, pathsNamed: () => [], commandResolves: () => true, ...overrides }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function hashes(dir: string): Record<string, string> {
  return Object.fromEntries(listing(dir).map(entry => [entry, entry.endsWith('/') ? 'directory' : sha256(path.join(dir, entry))]))
}

describe('intake fact check', () => {
  it('corrects a wrong path, a taken number and an invalid contour, and a named number is never used', () => {
    const dir = repository(['src/commands/intake/index.ts'])
    const { result, parking } = intake(
      [card({ number: 12, touches: ['src/command/intake/**'], contour: 'fast' }), card({ name: 'second-card', number: 40, touches: ['src/commands/intake/index.ts'] }), card({ name: 'third-card', touches: ['src/commands/intake/index.ts'] })],
      { dir, taken: '12' },
    )
    const first = written(result, parking, 13)
    const output = printed(result)
    for (const text of [
      'corrected: number — #12 → #13 — #12 is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake',
      'corrected: touches — src/command/intake/** → src/commands/intake/** — \'src/command/intake\' does not exist; \'src/commands/intake\' is the only path named \'intake\'',
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
    const journal = path.join(root, 'ghosts.jsonl')
    writeFileSync(journal, `${JSON.stringify({ event: 'path', task: '77', path: 'cheap', verification: 'run' })}\n${JSON.stringify({ event: 'merge', task: '77', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' })}\n${JSON.stringify({ event: 'start', task: '78' })}\n`)
    put(root, 'parking/13.md', '')
    const dir = repository(['src/a.ts'])
    const { result, parking } = intake([card({ depends: ['#77', '#13', '#78', '#900'], blocks: ['#77'] })], { root, dir, journal, taken: '12' })
    const text = written(result, parking, 14)
    const output = printed(result)
    expect(output).toContain('corrected: depends — #77 → (removed) — already merged')
    expect(output).toContain('corrected: blocks — #77 → (removed) — already merged')
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

  it('checks every backticked command of a witness and names the second one when it does not resolve', () => {
    const repo = repositoryFacts({ commandResolves: word => word === 'pnpm' })
    const [checked] = checkDraft([draftCard({ witnesses: ['`pnpm run quality` passes, then `nosuchtool --flag` fails'] })], [2], facts({ repository: repo }))
    expect(checked!.unclear.map(entry => entry.reason)).toEqual(['\'nosuchtool\' is not on PATH and is no file of the repository'])
  })

  it('gives a witness running `/usr/bin/env true` no unclear line', () => {
    const dir = repository(['src/a.ts'])
    const [checked] = checkDraft([draftCard({ witnesses: ['`/usr/bin/env true` exits 0'] })], [2], facts({ repository: new DirectoryFacts(dir, '') }))
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
    await runAttach(createUi(resolveTheme({ plain: true }), silentWriter), { dir, harness: 'true', yes: true })
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
    const dir = repository(['src/commands/intake/index.ts'])
    const journal = path.join(scratch(), 'ghosts.jsonl')
    writeFileSync(journal, `${JSON.stringify({ event: 'path', task: '77', path: 'cheap', verification: 'run' })}
${JSON.stringify({ event: 'merge', task: '77', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' })}
`)
    const draftBefore = JSON.stringify({ cards: [card({ number: 12, touches: ['src/command/intake/**'], contour: 'fast', depends: ['#77'] })] })
    const { result, parking, draftFile } = intake(JSON.parse(draftBefore).cards, { dir, journal, taken: '12' })
    const text = written(result, parking, 13)
    for (const was of ['#12', 'src/command/intake/**', 'fast', '#77'])
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
    'the scripts manifest': { repository: ['package.json', 'CONTRIBUTING.md', 'tests/harness-membership.test.ts'], touches: ['package.json'], added: ['CONTRIBUTING.md', 'tests/harness-membership.test.ts'] },
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
      const kept = facts({ repository: new DirectoryFacts(dir, '') })
      const [checked] = checkDraft([draftCard({ touches })], [2], kept)
      expect(checked!.touches).toEqual([...touches, ...added])
      expect(checked!.corrections).toEqual(added.map(now => ({ field: 'touches', was: '(absent)', now, reason: COMPANION_REASON })))
      expect(checkDraft([draftCard({ touches: checked!.touches })], [2], kept)[0]!.corrections).toEqual([])
      const row = COMPANION_TABLE.find(entry => entry.kind === kind)!
      rmSync(path.join(dir, row.keptBy), { recursive: true, force: true })
      expect(checkDraft([draftCard({ touches })], [2], kept)[0]!.touches).toEqual(touches)
    })
  }

  it('keeps who: shift on a corrected card with no unclear line', () => {
    const dir = repository(['src/commands/intake/index.ts'])
    const { result, parking } = intake([card({ who: 'shift', touches: ['src/command/intake/**'] })], { dir })
    const text = written(result, parking, 2)
    expect(text).toContain('corrected: touches — src/command/intake/** → src/commands/intake/**')
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
    const [checked] = checkDraft([draftCard({ witnesses: ['`/usr/bin/env node -v` passes', `\`${missing} --flag\` fails`] })], [2], facts({ repository: new DirectoryFacts(dir, '') }))
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
