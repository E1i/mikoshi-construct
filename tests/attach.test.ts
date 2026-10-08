import type { Ui, Writer } from '../src/ui/console.js'
import type { Prompter } from '../src/ui/prompts.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeExcludeBlock } from '../src/commands/attach/exclude.js'
import { ATTACH_RECORD_FILE, EXCLUDE_FILE, pathsInExcludeBlock, planCarriers, readAttachRecord, runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { originalCopyPath } from '../src/commands/attach/original.js'
import { ATTACH_LEDGER_DIR } from '../src/commands/attach/record.js'
import { rollbackAttach } from '../src/commands/attach/rollback.js'
import { runDetach } from '../src/commands/detach/index.js'
import { runDoctor } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { IGNORED_ENTRIES } from '../src/detect/ignored-entries.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { ATTACH_CARRIERS, ATTACH_GUARD, getPreset, groupsFor } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'
import { useIsolatedHome } from './isolated-home.js'
import { listing } from './repository-listing.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const HARNESS = 'pnpm run quality'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

function capturing(): { ui: Ui, output: () => string } {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  return { ui: createUi(resolveTheme({ plain: true }), write), output: () => text }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

function emptiedFixture(): string {
  const dir = fixture()
  for (const entry of readdirSync(dir).filter(entry => entry !== '.git'))
    rmSync(path.join(dir, entry), { recursive: true })
  return dir
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function porcelain(dir: string): string {
  return git(dir, 'status', '--porcelain')
}

function checkIgnore(dir: string, paths: string[]): string[] {
  const output = execFileSync('git', ['check-ignore', '--stdin'], { cwd: dir, input: `${paths.join('\n')}\n`, encoding: 'utf8' })
  return output.split('\n').filter(line => line !== '').sort()
}

function untracked(dir: string, directory: string): string[] {
  return execFileSync('git', ['ls-files', '--others', '--exclude-standard', directory], { cwd: dir, encoding: 'utf8' }).split('\n').filter(line => line !== '')
}

const MONOREPO_VARS = {
  projectName: 'example-monorepo',
  scope: '@example-monorepo',
  nodeMajor: '22',
  contracts: 'true',
  contractPath: 'contracts/api/openapi.yaml',
  contractTypesOutput: 'packages/shared/src/api/openapi.ts',
  compositionDir: 'architecture/composition',
  harnessCommand: HARNESS,
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: 'claude-sonnet-5',
  constructVersion: VERSION,
}

describe('a0 control: init on the same fixture changes tracked files', () => {
  it('leaves a non-empty git status naming the merged and appended targets', async () => {
    const dir = fixture()
    const result = await runInit(ui, { dir, preset: 'monorepo', yes: true, dryRun: false })
    expect(result.status).toBe('done')
    const status = porcelain(dir)
    expect(status).not.toBe('')
    for (const file of ['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'packages/shared/package.json'])
      expect(status, file).toContain(file)
  })
})

describe('a1: init plans merges and appends where attach plans only creates', () => {
  it('init dry run plans exactly five merge or append ops on tracked paths', async () => {
    const dir = fixture()
    const preset = getPreset('monorepo')
    const vars = { ...MONOREPO_VARS, ...preset.vars({ ...await import('../src/detect/index.js').then(m => m.detect(dir)) }, 'example-monorepo', null) }
    const plan = planMaterialize(dir, groupsFor(preset, 'claude', 'none'), vars, { emptyTarget: false, ai: 'claude' })
    const changing = plan.ops.filter(op => op.action === 'merge' || op.action === 'append').map(op => op.target).sort()
    expect(changing).toEqual(['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'packages/shared/package.json'])
    const dryRun = await runInit(ui, { dir, preset: 'monorepo', yes: true, dryRun: true })
    expect(dryRun.status).toBe('dry-run')
    expect(porcelain(dir)).toBe('')
  })

  it('attach plans only create ops, one per carrier, one for the guard and one for its parser', () => {
    const dir = fixture()
    const ops = planCarriers(dir, HARNESS)
    expect(ops.map(op => op.action)).toEqual(ops.map(() => 'create'))
    expect(ops.map(op => op.target).sort()).toEqual([...ATTACH_CARRIERS.targets, ATTACH_GUARD.target, ATTACH_GUARD.parser].sort())
  })
})

describe('a2: attach leaves the tracked tree untouched and records what it did', () => {
  it('keeps git status empty, hides every recorded file and the ledger, leaves no untracked entry in a recorded directory, and records a hash per recorded file matching disk', async () => {
    const dir = fixture()
    const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })
    expect(result.status).toBe('done')
    expect(porcelain(dir)).toBe('')

    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{"run":"r1"}\n')
    expect(porcelain(dir)).toBe('')

    const record = readAttachRecord(dir)
    expect(record).not.toBeNull()
    expect(record?.recordVersion).toBe(2)
    expect(record?.construct).toBe(VERSION)
    expect(Date.parse(record?.attachedAt ?? '')).not.toBeNaN()
    expect(record?.harness).toEqual({ command: HARNESS })
    expect(record?.excludeCreated).toBe(false)
    expect(record?.excludeSeparator).toBe(1)

    const files = Object.keys(record?.files ?? {}).sort()
    expect(files).toEqual([...ATTACH_CARRIERS.targets, ATTACH_GUARD.target, ATTACH_GUARD.parser].sort())
    for (const [file, sha] of Object.entries(record?.files ?? {}))
      expect(sha256(path.join(dir, file)), file).toBe(sha)

    const directories = record?.directories ?? []
    expect([...directories].sort()).toEqual(['.claude', '.claude/agents', '.claude/commands', '.claude/skills', '.claude/skills/browser-lab', '.claude/skills/implement', '.claude/skills/intake', 'scripts/construct'])
    for (const directory of directories)
      expect(directories.indexOf(path.dirname(directory)), `${directory} after its parent`).toBeLessThan(directories.indexOf(directory))

    const hidden = ['.construct/', ...files]
    expect(checkIgnore(dir, hidden)).toEqual([...hidden].sort())
    for (const directory of directories)
      expect(untracked(dir, directory), directory).toEqual([])
    writeFileSync(path.join(dir, '.claude/agents/probe.md'), 'not excluded\n')
    expect(untracked(dir, '.claude/agents')).toEqual(['.claude/agents/probe.md'])

    const exclude = readFileSync(path.join(dir, EXCLUDE_FILE), 'utf8')
    expect(pathsInExcludeBlock(exclude).sort()).toEqual(['.construct/', ...files, SETTINGS_FILE].sort())
    expect(files).not.toContain(ATTACH_RECORD_FILE)
    expect(directories).not.toContain('.construct')
  })

  it('creates .git/info/exclude when the repository has none and records that it did', async () => {
    const dir = fixture()
    rmSync(path.join(dir, '.git/info'), { recursive: true })
    const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })
    expect(result.status).toBe('done')
    expect(readAttachRecord(dir)?.excludeCreated).toBe(true)
    expect(readAttachRecord(dir)?.excludeSeparator).toBe(0)
    expect(porcelain(dir)).toBe('')
  })
})

interface RefusalCase {
  name: string
  refusal: string
  reason: string
  arrange: (dir: string) => void
  options?: { harness?: string, yes?: boolean, ai?: string }
}

const REFUSALS: RefusalCase[] = [
  { name: 'no .git', refusal: 'no-git', reason: PLAIN_LORE.attachRefusedNoGit, arrange: dir => rmSync(path.join(dir, '.git'), { recursive: true }) },
  { name: '.git is a file', refusal: 'linked-git', reason: PLAIN_LORE.attachRefusedLinkedGit, arrange: (dir) => {
    rmSync(path.join(dir, '.git'), { recursive: true })
    writeFileSync(path.join(dir, '.git'), 'gitdir: ../elsewhere/.git/worktrees/one\n')
  } },
  { name: 'construct.json is here', refusal: 'constructed', reason: PLAIN_LORE.attachRefusedConstructed, arrange: dir => writeFileSync(path.join(dir, 'construct.json'), '{}\n') },
  { name: 'an empty directory', refusal: 'nothing-to-attach', reason: PLAIN_LORE.attachRefusedNothingToAttach, arrange: (dir) => {
    for (const entry of readdirSync(dir).filter(entry => entry !== '.git'))
      rmSync(path.join(dir, entry), { recursive: true })
  } },
  { name: 'a directory with only a README', refusal: 'nothing-to-attach', reason: PLAIN_LORE.attachRefusedNothingToAttach, arrange: (dir) => {
    for (const entry of readdirSync(dir).filter(entry => entry !== '.git'))
      rmSync(path.join(dir, entry), { recursive: true })
    writeFileSync(path.join(dir, 'README.md'), '# only\n')
  } },
  { name: 'a carrier already exists', refusal: 'collision', reason: PLAIN_LORE.attachRefusedCollision(['.claude/commands/plan.md']), arrange: (dir) => {
    mkdirSync(path.join(dir, '.claude/commands'), { recursive: true })
    writeFileSync(path.join(dir, '.claude/commands/plan.md'), '# mine\n')
  } },
  { name: 'the acceptance check already exists', refusal: 'collision', reason: PLAIN_LORE.attachRefusedCollision(['scripts/construct/check-acceptance.mjs']), arrange: (dir) => {
    mkdirSync(path.join(dir, 'scripts/construct'), { recursive: true })
    writeFileSync(path.join(dir, 'scripts/construct/check-acceptance.mjs'), 'export {}\n')
  } },
  { name: '--yes without --harness', refusal: 'no-harness', reason: PLAIN_LORE.attachRefusedNoHarness, arrange: () => {}, options: { harness: undefined } },
  { name: '--ai cursor', refusal: 'cursor', reason: PLAIN_LORE.attachRefusedCursor, arrange: () => {}, options: { ai: 'cursor' } },
  { name: 'a harness that is a script name', refusal: 'not-a-command', reason: PLAIN_LORE.attachRefusedNotACommand('quality', ['npm run quality', 'npx quality']).what, arrange: () => {}, options: { harness: 'quality' } },
]

const LEDGER_DIRECTORY_CASES: { name: string, arrange: (dir: string) => void, refusal: string | undefined }[] = [
  { name: 'an empty .construct/ and nothing else', refusal: 'nothing-to-attach', arrange: dir => mkdirSync(path.join(dir, '.construct')) },
  { name: 'a .construct/ holding files and nothing else', refusal: 'nothing-to-attach', arrange: (dir) => {
    mkdirSync(path.join(dir, '.construct/mutations'), { recursive: true })
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{}\n')
  } },
  { name: 'a .construct/ holding files beside a README', refusal: 'nothing-to-attach', arrange: (dir) => {
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{}\n')
    writeFileSync(path.join(dir, 'README.md'), '# only\n')
  } },
  { name: 'construct.json beside an empty .construct/ and nothing else', refusal: 'constructed', arrange: (dir) => {
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, 'construct.json'), '{}\n')
  } },
  { name: 'a .construct/ holding files beside a project', refusal: undefined, arrange: (dir) => {
    cpSync(EXISTING_MONOREPO, dir, { recursive: true })
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{}\n')
  } },
]

describe('what attach does not count as a project is what detect ignores plus the ledger directory', () => {
  it('refuses a repository holding every ignored entry and the ledger directory and nothing else', async () => {
    const dir = emptiedFixture()
    for (const entry of [...IGNORED_ENTRIES, ATTACH_LEDGER_DIR]) {
      if (!existsSync(path.join(dir, entry)))
        mkdirSync(path.join(dir, entry))
    }

    const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })

    expect(result.refusal).toBe('nothing-to-attach')
  })
})

describe('the ledger directory is not something to attach to', () => {
  for (const ledger of LEDGER_DIRECTORY_CASES) {
    it(`${ledger.name}: ${ledger.refusal ?? 'attaches'}`, async () => {
      const dir = emptiedFixture()
      ledger.arrange(dir)
      const before = listing(dir)

      const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })

      expect(result.refusal).toBe(ledger.refusal)
      if (ledger.refusal != null)
        expect(listing(dir)).toEqual(before)
    })
  }
})

async function attachedAlready(dir: string, removeCarriers: boolean): Promise<void> {
  await runAttach(ui, { dir, harness: HARNESS, yes: true })
  if (!removeCarriers)
    return
  const record = readAttachRecord(dir)
  for (const target of Object.keys(record?.files ?? {}))
    rmSync(path.join(dir, target), { force: true })
  rmSync(path.join(dir, '.construct/commit-guard.mjs'), { force: true })
  rmSync(path.join(dir, SETTINGS_FILE), { force: true })
}

const ATTACHED_RECORD_CASES: { name: string, arrange: (dir: string) => Promise<void>, refusal: string | undefined }[] = [
  { name: 'the record beside a project, carriers removed', refusal: 'attached', arrange: dir => attachedAlready(dir, true) },
  { name: 'the record beside its carriers and the commit guard', refusal: 'attached', arrange: dir => attachedAlready(dir, false) },
  { name: 'the record and nothing else', refusal: 'attached', arrange: async (dir) => {
    for (const entry of readdirSync(dir).filter(entry => entry !== '.git'))
      rmSync(path.join(dir, entry), { recursive: true })
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, ATTACH_RECORD_FILE), '{}\n')
  } },
  { name: 'the record and construct.json', refusal: 'constructed', arrange: async (dir) => {
    await attachedAlready(dir, true)
    writeFileSync(path.join(dir, 'construct.json'), '{}\n')
  } },
  { name: 'an empty .construct/ beside a project', refusal: undefined, arrange: async (dir) => {
    mkdirSync(path.join(dir, '.construct'))
  } },
]

describe('a repository that already holds its attach record is not attached again', () => {
  for (const attached of ATTACHED_RECORD_CASES) {
    it(`${attached.name}: ${attached.refusal ?? 'attaches'}`, async () => {
      const dir = fixture()
      await attached.arrange(dir)
      const recordFile = path.join(dir, ATTACH_RECORD_FILE)
      const recordBefore = existsSync(recordFile) ? readFileSync(recordFile) : null
      const before = listing(dir)
      const { ui: plain, output } = capturing()

      const result = await runAttach(plain, { dir, harness: HARNESS, yes: true })

      expect(result.refusal).toBe(attached.refusal)
      if (attached.refusal == null) {
        expect(existsSync(recordFile)).toBe(true)
        return
      }
      expect(listing(dir)).toEqual(before)
      if (recordBefore != null)
        expect(readFileSync(recordFile).equals(recordBefore)).toBe(true)
      if (attached.refusal === 'attached')
        expect(output()).toContain(PLAIN_LORE.attachRefusedAttached)
    })
  }

  it('says which file holds the record and what to run first', () => {
    expect(PLAIN_LORE.attachRefusedAttached).toBe('Refused: this repository is already attached (.construct/attach.json is here); run `construct detach` first.')
  })
})

describe('a3: every refusal exits before anything is written', () => {
  for (const refusal of REFUSALS) {
    it(`${refusal.name}: refuses with its own reason and changes nothing`, async () => {
      const dir = fixture()
      refusal.arrange(dir)
      const excludeFile = path.join(dir, EXCLUDE_FILE)
      const excludeBefore = existsSync(excludeFile) ? readFileSync(excludeFile) : null
      const before = listing(dir)
      const { ui: plain, output } = capturing()

      const result = await runAttach(plain, { dir, harness: HARNESS, yes: true, ...refusal.options })

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe(refusal.refusal)
      expect(listing(dir)).toEqual(before)
      expect(existsSync(path.join(dir, '.construct'))).toBe(false)
      if (excludeBefore != null)
        expect(readFileSync(excludeFile).equals(excludeBefore)).toBe(true)
      expect(output()).toContain(refusal.reason)
      expect(output()).not.toContain('BREACH')
    })
  }

  it('a harness that is not a command says why and gives the command to run instead', async () => {
    const dir = fixture()
    const { ui: plain, output } = capturing()
    await runAttach(plain, { dir, harness: 'CI=1 vitest run', yes: true, env: { PATH: '' } })
    const notice = PLAIN_LORE.attachRefusedNotACommand('vitest', ['CI=1 npm run vitest run', 'CI=1 npx vitest run'])
    expect(output()).toContain(notice.what)
    expect(output()).toContain(notice.why)
    expect(output()).toContain('--harness \'CI=1 npx vitest run\'')
  })

  it('a harness that edits files is attached with a warning that names what edits and what to run instead', async () => {
    const dir = fixture()
    const { ui: plain, output } = capturing()
    const result = await runAttach(plain, { dir, harness: 'npx eslint . --fix', yes: true })
    const notice = PLAIN_LORE.attachHarnessEditsFiles(['--fix'])
    expect(result.status).toBe('done')
    expect(output()).toContain(notice.what)
    expect(output()).toContain(notice.why)
    expect(output()).toContain(notice.next)
  })

  it('lists the colliding paths after the reason', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.claude/agents'), { recursive: true })
    writeFileSync(path.join(dir, '.claude/agents/harness.md'), '# mine\n')
    writeFileSync(path.join(dir, '.claude/agents/architect.md'), '# mine\n')
    const { ui: plain, output } = capturing()
    await runAttach(plain, { dir, harness: HARNESS, yes: true })
    expect(output()).toContain('2 paths attach would create already exist:')
    expect(output()).toContain('.claude/agents/architect.md')
    expect(output()).toContain('.claude/agents/harness.md')
  })
})

describe('the carriers attach writes are the ones init writes', () => {
  it('writes byte-identical files into an attached repository and into a new project', async () => {
    const fresh = mkdtempSync(path.join(tmpdir(), 'construct-attach-init-'))
    await runInit(ui, { dir: fresh, preset: 'node-library', yes: true, dryRun: false })
    const attached = fixture()
    await runAttach(ui, { dir: attached, harness: HARNESS, yes: true })
    for (const target of ATTACH_CARRIERS.targets)
      expect(readFileSync(path.join(attached, target)).equals(readFileSync(path.join(fresh, target))), target).toBe(true)
  })

  it('reports the created paths, the trailer and the next steps without lore in plain mode', async () => {
    const dir = fixture()
    const { ui: plain, output } = capturing()
    await runAttach(plain, { dir, harness: HARNESS, yes: true })
    for (const target of ATTACH_CARRIERS.targets)
      expect(output()).toContain(`+ ${target}`)
    expect(output()).toContain(PLAIN_LORE.attached)
    expect(output()).toContain(`Attached-Construct: mikoshi-construct@${VERSION}`)
    expect(output()).toContain('/plan <feature>')
    expect(output()).toContain('construct detach')
    expect(output()).not.toContain('JACKED')
  })
})

describe('a carrier path that appears after the collision check is never overwritten', () => {
  const MINE = '# mine, written between the check and the write\n'

  function prompterThatRacesTheWrite(dir: string, target: string): Prompter {
    return {
      preset: () => Promise.resolve(undefined),
      aiTarget: () => Promise.resolve(undefined),
      projectName: () => Promise.resolve(undefined),
      review: () => Promise.resolve(undefined),
      harnessCommand: () => Promise.resolve(HARNESS),
      confirm: () => {
        mkdirSync(path.dirname(path.join(dir, target)), { recursive: true })
        writeFileSync(path.join(dir, target), MINE)
        return Promise.resolve(true)
      },
    }
  }

  const RACES = [
    { name: 'the first carrier, so nothing was written yet', target: ATTACH_CARRIERS.targets[0], appears: ['.claude/', '.claude/commands/', '.claude/commands/plan.md'], rolledBack: 0 },
    { name: 'the last carrier, so six files and their directories were written', target: ATTACH_CARRIERS.targets[6], appears: ['scripts/construct/', 'scripts/construct/implement.workflow'], rolledBack: 6 },
  ]

  for (const race of RACES) {
    it(`${race.name}: refuses with COLLISION, removes only what this run wrote and restores the exclude file`, async () => {
      const dir = fixture()
      const excludeBefore = readFileSync(path.join(dir, EXCLUDE_FILE))
      const before = listing(dir)
      const { ui: plain, output } = capturing()

      const result = await runAttach(plain, { dir, yes: false }, prompterThatRacesTheWrite(dir, race.target))

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe('collision')
      expect(result.rolledBack).toHaveLength(race.rolledBack)
      expect(readFileSync(path.join(dir, race.target), 'utf8')).toBe(MINE)
      expect(readFileSync(path.join(dir, EXCLUDE_FILE)).equals(excludeBefore)).toBe(true)
      expect(listing(dir)).toEqual([...before, ...race.appears].sort())
      expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(false)
      expect(output()).toContain(PLAIN_LORE.attachRefusedCollision([race.target]))
      expect(output()).toContain(race.target)
    })
  }
})

describe('the rollback removes only the block this run added to .git/info/exclude', () => {
  it('keeps a line appended by hand after the block when the file did not exist before', () => {
    const dir = fixture()
    rmSync(path.join(dir, '.git/info'), { recursive: true })
    const exclude = writeExcludeBlock(dir, [...ATTACH_CARRIERS.targets])
    appendFileSync(path.join(dir, EXCLUDE_FILE), 'mine/\n')
    rollbackAttach(dir, { written: [], directories: [], separator: exclude.separator })
    expect(readFileSync(path.join(dir, EXCLUDE_FILE), 'utf8')).toBe('mine/\n')
  })

  it('leaves the block alone and says so when the bytes before it are no longer the separator it wrote', () => {
    const dir = fixture()
    const exclude = writeExcludeBlock(dir, [...ATTACH_CARRIERS.targets])
    const file = path.join(dir, EXCLUDE_FILE)
    const edited = readFileSync(file, 'utf8').replace('\n\n# construct:begin', '\n# construct:begin')
    writeFileSync(file, edited)

    const rollback = rollbackAttach(dir, { written: [], directories: [], separator: exclude.separator })

    expect(rollback.excludeKept).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(edited)
  })
})

function goRepository(withServices: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-go-'))
  writeFileSync(path.join(dir, 'go.mod'), 'module example.com/billing\n\ngo 1.23\n')
  writeFileSync(path.join(dir, 'Makefile'), 'check:\n\tgo vet ./... && go test ./...\n')
  mkdirSync(path.join(dir, 'cmd/billing'), { recursive: true })
  writeFileSync(path.join(dir, 'cmd/billing/main.go'), 'package main\n\nfunc main() {}\n')
  mkdirSync(path.join(dir, 'internal/ledger'), { recursive: true })
  writeFileSync(path.join(dir, 'internal/ledger/ledger.go'), 'package ledger\n')
  if (withServices) {
    mkdirSync(path.join(dir, 'services/billing'), { recursive: true })
    writeFileSync(path.join(dir, 'services/billing/b.go'), 'package billing\n')
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

describe('attach decides without reading the stack (#232)', () => {
  it('attaches a Go repository with a named harness, and detach returns it to what it was', async () => {
    const dir = goRepository(false)
    const before = listing(dir)

    const result = await runAttach(ui, { dir, harness: 'make check', yes: true })

    expect(result.status).toBe('done')
    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(listing(dir)).toEqual(before)
  })

  it('refuses a Go repository with --yes and no --harness as no-harness, and changes nothing', async () => {
    const dir = goRepository(false)
    const before = listing(dir)

    const result = await runAttach(ui, { dir, harness: undefined, yes: true })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('no-harness')
    expect(listing(dir)).toEqual(before)
  })

  it('reads an attached Go repository as attached, never checked, without a report', async () => {
    const dir = goRepository(false)
    expect((await runAttach(ui, { dir, harness: 'make check', yes: true })).status).toBe('done')

    const result = runDoctor(dir)
    if (result == null || !('state' in result))
      throw new Error('expected an attached report')
    expect(result.state).toBe('attached')
    expect(result.harness.command).toBe('make check')
    expect(result.harness.state).not.toBe('checked')
  })

  it('gives a Go repository the same decision with and without a services/ directory', async () => {
    const without = await runAttach(ui, { dir: goRepository(false), harness: 'make check', yes: true })
    const withServices = await runAttach(ui, { dir: goRepository(true), harness: 'make check', yes: true })

    expect(without.status).toBe(withServices.status)
    expect(without.refusal).toBe(withServices.refusal)
  })
})

const GUARD_ENTRY = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/${ATTACH_GUARD.target}`, timeout: 30 }],
}

function writeSettings(dir: string, content: string): void {
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, SETTINGS_FILE), content)
}

function readSettings(dir: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))
}

describe('the commit guard: attach installs one entry in the untracked settings file', () => {
  it('the commit guard: creates the settings file holding exactly the entry, hides it and records what it created', async () => {
    const dir = fixture()

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(readSettings(dir)).toEqual({ hooks: { PreToolUse: [GUARD_ENTRY] } })
    expect(porcelain(dir)).toBe('')
    expect(readAttachRecord(dir)?.settingsHook).toEqual({ file: SETTINGS_FILE, created: { file: true, hooks: true, preToolUse: true }, entry: GUARD_ENTRY })
    expect(readFileSync(path.join(dir, ATTACH_GUARD.target)).equals(readFileSync(path.join(import.meta.dirname, '../templates/attach/_construct/commit-guard.mjs')))).toBe(true)
    expect(readAttachRecord(dir)?.files[ATTACH_GUARD.target]).toBe(sha256(path.join(dir, ATTACH_GUARD.target)))
  })

  it('the commit guard: appends the entry to an untracked file with grants and other hooks, keeps the rest and records that it created nothing', async () => {
    const dir = fixture()
    const existing = { permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'true' }] }], Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }
    writeSettings(dir, JSON.stringify(existing))

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(readSettings(dir)).toEqual({ ...existing, hooks: { ...existing.hooks, PreToolUse: [...existing.hooks.PreToolUse, GUARD_ENTRY] } })
    expect(readAttachRecord(dir)?.settingsHook?.created).toEqual({ file: false, hooks: false, preToolUse: false })
    expect(porcelain(dir)).toBe('')
  })

  it('the commit guard: adds hooks to a file that has none and records that it created hooks and PreToolUse but not the file', async () => {
    const dir = fixture()
    writeSettings(dir, JSON.stringify({ permissions: { allow: [] } }))

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(readSettings(dir)).toEqual({ permissions: { allow: [] }, hooks: { PreToolUse: [GUARD_ENTRY] } })
    expect(readAttachRecord(dir)?.settingsHook?.created).toEqual({ file: false, hooks: true, preToolUse: true })
  })

  const SETTINGS_REFUSALS: { name: string, reason: string, arrange: (dir: string) => void }[] = [
    { name: 'a file that does not parse', reason: 'settings-unreadable', arrange: dir => writeSettings(dir, '{ nope') },
    { name: 'a PreToolUse that is not a list', reason: 'settings-unreadable', arrange: dir => writeSettings(dir, JSON.stringify({ hooks: { PreToolUse: {} } })) },
    { name: 'a hooks that is not an object', reason: 'settings-unreadable', arrange: dir => writeSettings(dir, JSON.stringify({ hooks: [] })) },
    { name: 'a file that is not an object', reason: 'settings-unreadable', arrange: dir => writeSettings(dir, '[]') },
    { name: 'a symlink', reason: 'settings-unreadable', arrange: (dir) => {
      mkdirSync(path.join(dir, '.claude'), { recursive: true })
      writeFileSync(path.join(dir, 'elsewhere.json'), '{}\n')
      symlinkSync(path.join(dir, 'elsewhere.json'), path.join(dir, SETTINGS_FILE))
    } },
    { name: 'a guard entry already there', reason: 'settings-guarded', arrange: dir => writeSettings(dir, JSON.stringify({ hooks: { PreToolUse: [GUARD_ENTRY] } })) },
    { name: 'a tracked file', reason: 'settings-tracked', arrange: (dir) => {
      writeSettings(dir, '{}\n')
      git(dir, 'add', '-f', SETTINGS_FILE)
      git(dir, 'commit', '-qm', 'track settings')
    } },
    { name: 'a version-4 index with the file in it', reason: 'settings-index', arrange: (dir) => {
      writeSettings(dir, '{}\n')
      git(dir, 'update-index', '--index-version', '4')
    } },
  ]

  for (const refusal of SETTINGS_REFUSALS) {
    it(`the commit guard: ${refusal.name} is refused as ${refusal.reason}, naming the settings file, with nothing written`, async () => {
      const dir = fixture()
      refusal.arrange(dir)
      const excludeBefore = readFileSync(path.join(dir, EXCLUDE_FILE))
      const before = listing(dir)
      const { ui: plain, output } = capturing()

      const result = await runAttach(plain, { dir, harness: HARNESS, yes: true })

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe(refusal.reason)
      expect(output()).toContain(SETTINGS_FILE)
      expect(output()).not.toContain('Rolled back')
      expect(listing(dir)).toEqual(before)
      expect(existsSync(path.join(dir, '.construct'))).toBe(false)
      expect(readFileSync(path.join(dir, EXCLUDE_FILE)).equals(excludeBefore)).toBe(true)
    })
  }

  it('the commit guard: a repository without the settings file, and a version-4 index with none, attach', async () => {
    const plainRepository = fixture()
    const versionFour = fixture()
    git(versionFour, 'update-index', '--index-version', '4')

    expect((await runAttach(ui, { dir: plainRepository, harness: HARNESS, yes: true })).status).toBe('done')
    expect((await runAttach(ui, { dir: versionFour, harness: HARNESS, yes: true })).status).toBe('done')
  })

  it('the commit guard: a settings file that stops parsing between the check and the write rolls back this run and restores the exclude file', async () => {
    const dir = fixture()
    const excludeBefore = readFileSync(path.join(dir, EXCLUDE_FILE))
    const before = listing(dir)
    const racing: Prompter = {
      preset: () => Promise.resolve(undefined),
      aiTarget: () => Promise.resolve(undefined),
      projectName: () => Promise.resolve(undefined),
      review: () => Promise.resolve(undefined),
      harnessCommand: () => Promise.resolve(HARNESS),
      confirm: () => {
        writeSettings(dir, '{ nope')
        return Promise.resolve(true)
      },
    }
    const { ui: plain, output } = capturing()

    const result = await runAttach(plain, { dir, yes: false }, racing)

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('settings-unreadable')
    expect(result.rolledBack).toHaveLength(14)
    expect(listing(dir)).toEqual([...before, '.claude/', SETTINGS_FILE].sort())
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe('{ nope')
    expect(existsSync(path.join(dir, '.construct'))).toBe(false)
    expect(readFileSync(path.join(dir, EXCLUDE_FILE)).equals(excludeBefore)).toBe(true)
    expect(output()).toContain(PLAIN_LORE.attachRefusedSettingsUnreadable.what)
  })
})

const HOST_SETTINGS = '{"env":{"NOTE":"zebra-lantern-marker"},"permissions":{"allow":["Bash(ls:*)"]}}'

function sha256OfText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function recordedCopy(dir: string): string {
  const copy = readAttachRecord(dir)?.settingsHook?.original?.copy
  if (copy == null)
    throw new Error('attach kept no copy')
  return copy
}

function filesInHome(): string[] {
  return listing(home()).filter(entry => !entry.endsWith('/'))
}

function racingPrompter(beforeConfirm: () => void): Prompter {
  return {
    preset: () => Promise.resolve(undefined),
    aiTarget: () => Promise.resolve(undefined),
    projectName: () => Promise.resolve(undefined),
    review: () => Promise.resolve(undefined),
    harnessCommand: () => Promise.resolve(HARNESS),
    confirm: () => {
      beforeConfirm()
      return Promise.resolve(true)
    },
  }
}

describe('the pre-image of a host settings file: attach keeps a copy outside the repository', () => {
  it('attach copies the host settings file with mode 0600 and records its sha256, not its text', async () => {
    const dir = fixture()
    writeSettings(dir, HOST_SETTINGS)

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    const copy = recordedCopy(dir)
    expect(copy).toBe(originalCopyPath(dir))
    expect(copy.startsWith(path.join(home(), '.construct/attach'))).toBe(true)
    expect(statSync(copy).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(copy)).mode & 0o777).toBe(0o700)
    expect(readFileSync(copy, 'utf8')).toBe(HOST_SETTINGS)
    const original = readAttachRecord(dir)?.settingsHook?.original
    expect(original?.sha256).toBe(sha256OfText(HOST_SETTINGS))
    expect(original?.afterSha256).toBe(sha256(path.join(dir, SETTINGS_FILE)))
    expect(readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')).not.toContain('zebra-lantern-marker')
  })

  it('attach with no host settings file makes no copy', async () => {
    const dir = fixture()

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(filesInHome()).toEqual([])
    expect(readAttachRecord(dir)?.settingsHook?.original).toBeUndefined()
  })

  it('records the runtime files and the browser directory that were there before attach', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct/browser'), { recursive: true })
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{}\n')

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(readAttachRecord(dir)?.ledgerHeld).toEqual(['.construct/runs.jsonl', '.construct/browser'])
  })

  it('records the names that were in .construct/browser before attach', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct/browser/20200101T000000000Z-1'), { recursive: true })
    writeFileSync(path.join(dir, '.construct/browser/notes.txt'), 'mine\n')

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')

    expect(readAttachRecord(dir)?.browserHeld).toEqual(['20200101T000000000Z-1', 'notes.txt'])
    expect(readAttachRecord(dir)?.recordVersion).toBe(2)
  })

  it('attach refuses with original-pending when an earlier copy is still there, and leaves the copy byte-identical', async () => {
    const withSettings = fixture()
    const withoutSettings = fixture()
    writeSettings(withSettings, HOST_SETTINGS)
    for (const dir of [withSettings, withoutSettings]) {
      const copy = originalCopyPath(dir)
      mkdirSync(path.dirname(copy), { recursive: true })
      writeFileSync(copy, 'earlier bytes')
      const before = listing(dir)
      const excludeBefore = readFileSync(path.join(dir, EXCLUDE_FILE))
      const { ui: plain, output } = capturing()

      const result = await runAttach(plain, { dir, harness: HARNESS, yes: true })

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe('original-pending')
      expect(output()).toContain(copy)
      expect(readFileSync(copy, 'utf8')).toBe('earlier bytes')
      expect(listing(dir)).toEqual(before)
      expect(readFileSync(path.join(dir, EXCLUDE_FILE)).equals(excludeBefore)).toBe(true)
    }
  })

  it('attach after a finished detach succeeds', async () => {
    const dir = fixture()
    writeSettings(dir, HOST_SETTINGS)
    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
    expect(runDetach(ui, { dir }).status).toBe('done')

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
  })

  it('two repositories with the same basename get different copy directories', async () => {
    const first = path.join(mkdtempSync(path.join(tmpdir(), 'construct-same-')), 'app')
    const second = path.join(mkdtempSync(path.join(tmpdir(), 'construct-same-')), 'app')
    for (const dir of [first, second]) {
      cpSync(EXISTING_MONOREPO, dir, { recursive: true })
      git(dir, 'init', '-q')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-qm', 'base')
      writeSettings(dir, HOST_SETTINGS)
      expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
    }

    const names = [first, second].map(dir => path.basename(path.dirname(recordedCopy(dir))))
    expect(names[0]).not.toBe(names[1])
    for (const name of names)
      expect(name).toMatch(/^[0-9a-f]{12}-app$/)
  })

  it('a symlink to the repository gets the directory name of its real path and a subdirectory is refused as no-git', async () => {
    const dir = fixture()
    writeSettings(dir, HOST_SETTINGS)
    mkdirSync(path.join(dir, 'sub'))
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'construct-link-')), 'link')
    symlinkSync(dir, link)

    const subdirectory = await runAttach(ui, { dir: path.join(dir, 'sub'), harness: HARNESS, yes: true })
    expect(subdirectory.refusal).toBe('no-git')
    expect(filesInHome()).toEqual([])
    expect((await runAttach(ui, { dir: link, harness: HARNESS, yes: true })).status).toBe('done')

    const real = realpathSync(dir)
    const key = `${sha256OfText(real).slice(0, 12)}-${path.basename(real)}`
    expect(path.basename(path.dirname(recordedCopy(link)))).toBe(key)
  })

  it('the copy path in the record, not a recomputed key, is what detach reads after the repository is renamed', async () => {
    const dir = fixture()
    writeSettings(dir, HOST_SETTINGS)
    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
    const moved = `${dir}-moved`
    renameSync(dir, moved)

    expect(runDetach(ui, { dir: moved }).status).toBe('done')

    expect(readFileSync(path.join(moved, SETTINGS_FILE), 'utf8')).toBe(HOST_SETTINGS)
    expect(filesInHome()).toEqual([])
  })

  it('an unwritable home refuses with settings-original, rolls back and leaves the settings file as found', async () => {
    const dir = fixture()
    writeSettings(dir, HOST_SETTINGS)
    writeFileSync(path.join(home(), '.construct'), 'in the way')
    const before = listing(dir)
    const excludeBefore = readFileSync(path.join(dir, EXCLUDE_FILE))
    const { ui: plain, output } = capturing()

    const result = await runAttach(plain, { dir, harness: HARNESS, yes: true })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('settings-original')
    expect(output()).toContain(PLAIN_LORE.attachRefusedSettingsOriginal.what)
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(HOST_SETTINGS)
    expect(listing(dir)).toEqual(before)
    expect(readFileSync(path.join(dir, EXCLUDE_FILE)).equals(excludeBefore)).toBe(true)
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(false)
  })

  it('a copy created between the check and the write is refused as settings-original and stays byte-identical', async () => {
    const dir = fixture()
    writeSettings(dir, HOST_SETTINGS)
    const copy = originalCopyPath(dir)
    const before = listing(dir)

    const result = await runAttach(ui, { dir, yes: false }, racingPrompter(() => {
      mkdirSync(path.dirname(copy), { recursive: true })
      writeFileSync(copy, 'racing bytes')
    }))

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('settings-original')
    expect(readFileSync(copy, 'utf8')).toBe('racing bytes')
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(HOST_SETTINGS)
    expect(listing(dir)).toEqual(before)
  })
})
