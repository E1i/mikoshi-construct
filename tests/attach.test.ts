import type { Ui, Writer } from '../src/ui/console.js'
import type { Prompter } from '../src/ui/prompts.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeExcludeBlock } from '../src/commands/attach/exclude.js'
import { ATTACH_RECORD_FILE, EXCLUDE_FILE, pathsInExcludeBlock, planCarriers, readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { rollbackAttach } from '../src/commands/attach/rollback.js'
import { runInit } from '../src/commands/init.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { ATTACH_CARRIERS, getPreset, groupsFor } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'
import { listing } from './repository-listing.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const HARNESS = 'pnpm run quality'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

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

  it('attach plans only create ops, one per carrier', () => {
    const dir = fixture()
    const ops = planCarriers(dir, HARNESS)
    expect(ops.map(op => op.action)).toEqual(ops.map(() => 'create'))
    expect(ops.map(op => op.target).sort()).toEqual([...ATTACH_CARRIERS.targets].sort())
  })
})

describe('a2: attach leaves the tracked tree untouched and records what it did', () => {
  it('keeps git status empty, hides every recorded file and the ledger, leaves no untracked entry in a recorded directory, and records eight hashes matching disk', async () => {
    const dir = fixture()
    const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })
    expect(result.status).toBe('done')
    expect(porcelain(dir)).toBe('')

    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{"run":"r1"}\n')
    expect(porcelain(dir)).toBe('')

    const record = readAttachRecord(dir)
    expect(record).not.toBeNull()
    expect(record?.recordVersion).toBe(1)
    expect(record?.construct).toBe(VERSION)
    expect(Date.parse(record?.attachedAt ?? '')).not.toBeNaN()
    expect(record?.harness).toEqual({ command: HARNESS })
    expect(record?.excludeCreated).toBe(false)
    expect(record?.excludeSeparator).toBe(1)

    const files = Object.keys(record?.files ?? {}).sort()
    expect(files).toEqual([...ATTACH_CARRIERS.targets].sort())
    for (const [file, sha] of Object.entries(record?.files ?? {}))
      expect(sha256(path.join(dir, file)), file).toBe(sha)

    const directories = record?.directories ?? []
    expect([...directories].sort()).toEqual(['.claude', '.claude/agents', '.claude/commands', '.claude/skills', '.claude/skills/implement', 'scripts/construct'])
    for (const directory of directories)
      expect(directories.indexOf(path.dirname(directory)), `${directory} after its parent`).toBeLessThan(directories.indexOf(directory))

    const hidden = ['.construct/', ...files]
    expect(checkIgnore(dir, hidden)).toEqual([...hidden].sort())
    for (const directory of directories)
      expect(untracked(dir, directory), directory).toEqual([])
    writeFileSync(path.join(dir, '.claude/agents/probe.md'), 'not excluded\n')
    expect(untracked(dir, '.claude/agents')).toEqual(['.claude/agents/probe.md'])

    const exclude = readFileSync(path.join(dir, EXCLUDE_FILE), 'utf8')
    expect(pathsInExcludeBlock(exclude).sort()).toEqual(['.construct/', ...files].sort())
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
  { name: 'an empty directory', refusal: 'unsupported-stack', reason: PLAIN_LORE.attachRefusedUnsupportedStack, arrange: (dir) => {
    for (const entry of readdirSync(dir).filter(entry => entry !== '.git'))
      rmSync(path.join(dir, entry), { recursive: true })
  } },
  { name: 'a directory with only a README', refusal: 'unsupported-stack', reason: PLAIN_LORE.attachRefusedUnsupportedStack, arrange: (dir) => {
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
  { name: 'the contract-paths script already exists', refusal: 'collision', reason: PLAIN_LORE.attachRefusedCollision(['scripts/construct/contract-paths.mjs']), arrange: (dir) => {
    mkdirSync(path.join(dir, 'scripts/construct'), { recursive: true })
    writeFileSync(path.join(dir, 'scripts/construct/contract-paths.mjs'), 'export {}\n')
  } },
  { name: '--yes without --harness', refusal: 'no-harness', reason: PLAIN_LORE.attachRefusedNoHarness, arrange: () => {}, options: { harness: undefined } },
  { name: '--ai cursor', refusal: 'cursor', reason: PLAIN_LORE.attachRefusedCursor, arrange: () => {}, options: { ai: 'cursor' } },
]

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
    { name: 'the last carrier, so seven files and their directories were written', target: ATTACH_CARRIERS.targets[7], appears: ['scripts/construct/', 'scripts/construct/contract-paths.mjs'], rolledBack: 7 },
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
