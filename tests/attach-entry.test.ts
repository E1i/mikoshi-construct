import type { Ui, Writer } from '../src/ui/console.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'
import { listing } from './repository-listing.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(REPO_ROOT, 'src/cli.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const PROTOCOL = readFileSync(path.join(REPO_ROOT, 'templates/attach/entry.md'), 'utf8')

function capturing(name: 'plain' | 'arasaka'): { ui: Ui, output: () => string } {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  return { ui: createUi({ ...resolveTheme({ plain: true }), name }, write), output: () => text }
}

function repository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-entry-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(path.join(dir, 'main.go'), 'package main\n')
  return dir
}

describe('attach --entry', () => {
  it('prints the subtitle, a blank line and the protocol whole, in a directory that is not a repository', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'construct-entry-bare-'))
    const child = spawnSync(process.execPath, [TSX_CLI, CLI, 'attach', '--entry', '--plain', '--dir', bare], { encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(child.stdout).toBe(`${PLAIN_LORE.subtitle(VERSION)}\n\n${PROTOCOL.trimEnd()}\n`)
    expect(listing(bare)).toEqual([])
  })

  it('writes nothing into a repository, even with --yes and --harness given', () => {
    const root = repository()
    const before = listing(root)
    const child = spawnSync(process.execPath, [TSX_CLI, CLI, 'attach', '--entry', '--plain', '--yes', '--harness', 'true', '--dir', root], { encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(listing(root)).toEqual(before)
  })

  it('names what the agent reads, the table, the upstream comparison and the one question', () => {
    const named = [
      '.github/workflows',
      '.gitlab-ci.yml',
      'package.json',
      'Makefile',
      'pyproject.toml',
      '.husky/',
      '.pre-commit-config.yaml',
      '.git/hooks/',
      'README',
      'Suite | Runner | Where | Run by CI',
      'not run by CI',
      'Not run by CI:',
      'git rev-list --left-right --count HEAD...@{upstream}',
      'FETCH_HEAD',
      'Fetch only when the owner says yes',
      'exactly one command, in one form',
      'yes or no',
      'npx mikoshi-construct attach --yes --harness',
      'Write nothing',
    ]
    for (const phrase of named)
      expect(PROTOCOL).toContain(phrase)
    expect(PROTOCOL.split('npx mikoshi-construct attach').length - 1).toBe(1)
  })
})

describe('attach --yes without --harness', () => {
  it.each(['plain', 'arasaka'] as const)('is refused in the %s theme with a next step that names attach --entry, and writes nothing', async (name) => {
    const root = repository()
    const before = listing(root)
    const { ui, output } = capturing(name)
    const result = await runAttach(ui, { dir: root, yes: true })
    expect(result.refusal).toBe('no-harness')
    expect(output()).toContain('attach --entry')
    if (name === 'plain') {
      expect(output()).toContain(PLAIN_LORE.attachRefusedNoHarness)
      expect(output()).toContain('Why:')
      expect(output()).toContain('Next: npx mikoshi-construct attach --entry')
    }
    expect(listing(root)).toEqual(before)
  })

  it('attaches the same repository once a harness is named', async () => {
    const root = repository()
    const result = await runAttach(capturing('plain').ui, { dir: root, yes: true, harness: 'true' })
    expect(result.status).toBe('done')
  })
})
