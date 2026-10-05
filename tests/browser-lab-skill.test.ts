import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { EXCLUDE_FILE, readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT_PATH = 'scripts/construct/browser-lab.mjs'
const SKILL_TEMPLATE = 'templates/ai/claude/_claude/skills/browser-lab/SKILL.md'
const SKILL_COPY = '.claude/skills/browser-lab/SKILL.md'
const UNOBSERVED_EXIT = 127
const FLAG = /--[a-z]+/g
const FENCE = /```(\w*)\n([\s\S]*?)```/g
const SCRIPT_CALL = /^node scripts\/construct\/browser-lab\.mjs (\S+)/gm
const USAGE_ENTRY = /^ {2}([a-z][a-z-]*)(?: \| ([a-z][a-z-]*))?(?= [<[]| {2})/

const CARRIED = [SCRIPT_PATH, SKILL_COPY]
const TEMPLATE_OF: Record<string, string> = {
  [SCRIPT_PATH]: `templates/ai/claude/${SCRIPT_PATH}`,
  [SKILL_COPY]: SKILL_TEMPLATE,
}

function read(file: string): string {
  try {
    return readFileSync(path.join(REPO_ROOT, file), 'utf8')
  }
  catch {
    return ''
  }
}

function usageOfTheScript(): string {
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, SCRIPT_PATH)], { encoding: 'utf8' })
  expect(run.status).toBe(UNOBSERVED_EXIT)
  return run.stderr
}

function commandsOfTheUsage(usage: string): string[] {
  return usage.split('\n')
    .flatMap((line) => {
      const [, first, second] = USAGE_ENTRY.exec(line) ?? []
      return [first, second].filter((name): name is string => name !== undefined)
    })
    .sort()
}

function fencesOf(skill: string): { language: string, body: string }[] {
  return [...skill.matchAll(FENCE)].map(found => ({ language: found[1] ?? '', body: found[2] ?? '' }))
}

function commandsOfTheSkill(skill: string): string[] {
  return [...new Set(fencesOf(skill).flatMap(fence => [...fence.body.matchAll(SCRIPT_CALL)].map(found => found[1] ?? '')))].sort()
}

describe('the browser-lab skill states the script it carries', () => {
  const skill = read(SKILL_TEMPLATE)

  it('names the script by its full path', () => {
    expect(skill).toContain(SCRIPT_PATH)
  })

  it('shows exactly the commands the script prints in its usage, no more and no fewer', () => {
    const inUsage = commandsOfTheUsage(usageOfTheScript())
    expect(inUsage.length).toBeGreaterThanOrEqual(7)
    expect(commandsOfTheSkill(skill)).toEqual(inUsage)
  })

  it('names no flag the script does not print in its usage', () => {
    const usage = usageOfTheScript()
    const flags = new Set(skill.match(FLAG) ?? [])
    expect(flags.size).toBeGreaterThan(0)
    for (const flag of flags)
      expect(usage, flag).toContain(flag)
  })

  it('is invoked by the model and by the person, and keeps its description on one line', () => {
    const [, frontmatter = ''] = skill.split('---\n')
    expect(frontmatter).toMatch(/^user-invocable: true$/m)
    expect(frontmatter).not.toContain('disable-model-invocation')
    expect(frontmatter).toMatch(/^description: \S.*$/m)
  })

  it('fences only bash, writes no home path and leaves to a person the Web Store, the permission prompts and the sign-in', () => {
    for (const fence of fencesOf(skill))
      expect(fence.language).toBe('bash')
    expect(skill).not.toContain('~/')
    expect(skill).toContain('Web Store')
    expect(skill).toMatch(/permission prompts/)
    expect(skill).toMatch(/signing in/)
  })

  it('is this repository\'s own copy, byte for byte', () => {
    expect(read(SKILL_COPY)).toBe(skill)
  })
})

describe('attach carries the browser lab into a repository that has no JavaScript', () => {
  function goRepository(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-lab-attach-'))
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    writeFileSync(path.join(dir, 'main.go'), 'package main\n\nfunc main() {}\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
    return dir
  }

  it('writes the skill and the script byte for byte as the templates are, records and hides both, and leaves the tree clean with no package.json', async () => {
    const dir = goRepository()
    try {
      const result = await runAttach(createUi(resolveTheme({ plain: true }), silentWriter), { dir, harness: 'go test ./...', yes: true })
      expect(result.status).toBe('done')
      const record = readAttachRecord(dir)
      const exclude = readFileSync(path.join(dir, EXCLUDE_FILE), 'utf8').split('\n')
      for (const target of CARRIED) {
        expect(existsSync(path.join(dir, target)), target).toBe(true)
        expect(readFileSync(path.join(dir, target)).equals(readFileSync(path.join(REPO_ROOT, TEMPLATE_OF[target] ?? ''))), target).toBe(true)
        expect(Object.keys(record?.files ?? {}), target).toContain(target)
        expect(exclude, target).toContain(target)
      }
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('')
      expect(existsSync(path.join(dir, 'package.json'))).toBe(false)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
