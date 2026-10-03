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

const ABSENCE_RULE = 'An absence is a finding'

function section(heading: string): string {
  const start = PROTOCOL.indexOf(`\n## ${heading}\n`)
  if (start === -1)
    return ''
  const body = PROTOCOL.slice(start + heading.length + 5)
  const end = body.indexOf('\n## ')
  return end === -1 ? body : body.slice(0, end)
}

const SECTIONS_THAT_REPORT_AN_ABSENCE: Record<string, string> = {
  'Where the tree stands': 'no upstream',
  'The conventions in the history': 'no convention',
  'What the toolchain needs': 'does not resolve',
  'What the repository can run': 'no hooks',
  'The test surface': 'not run by CI',
  'The proposal': 'left out',
}

describe('the attach entry protocol proves an absence like a finding', () => {
  it('sends the search past the declaring file and the loader to the step or call where the value decides', () => {
    const rule = section(ABSENCE_RULE)
    expect(rule).toContain('the place where the value decides')
    expect(rule).toContain('the CI step that runs the command')
    expect(rule).toContain('the call that reads the setting and acts on it')
    expect(rule).toMatch(/A file that declares the value, or the loader that reads it in, is not that place/)
    expect(rule).toContain('`not determined`')
  })

  it('puts the search command and what it returned beside every absence', () => {
    const rule = section(ABSENCE_RULE)
    expect(rule).toContain('Write the search command and what it returned beside the absence, never the bare word')
    expect(section('The test surface')).toMatch(/`not run by CI` carries the searches that went through every job's steps and what they returned/)
    expect(section('The test surface')).toMatch(/`Not run by CI:`, one line per suite, each with where it lives and the search that showed no step runs it/)
  })

  it.each(Object.entries(SECTIONS_THAT_REPORT_AN_ABSENCE))('holds %s to the rule where it asks for %s', (heading, absence) => {
    const body = section(heading)
    expect(body).toContain(absence)
    expect(body).toContain(`as ${ABSENCE_RULE} says`)
  })

  it('keeps the proposal one command that carries no fix and is never run', () => {
    const proposal = section('The proposal')
    expect(proposal).toContain('Propose exactly one command, in one form.')
    expect(proposal).toContain('It carries no `:fix` script, no `--fix` and no `--write`')
    expect(proposal).toContain('Do not run it to find out whether it passes.')
  })
})

describe('the attach entry protocol reads the conventions from the history', () => {
  const HISTORY = 'The conventions in the history'

  it('derives the branch convention from the remote branches as last fetched, by prefix, separator and ticket key', () => {
    const body = section(HISTORY)
    expect(body).toContain('git for-each-ref --format=\'%(refname:lstrip=3)\' refs/remotes/<remote>')
    expect(body).toMatch(/the remote-tracking refs as last fetched, and the same fetch rule holds/)
    for (const form of ['the prefix before the first `/`', 'the separator between words', 'a ticket key'])
      expect(body).toContain(form)
    expect(PROTOCOL).toContain('How the repository names its branches and writes its commits is read from its history, never asked.')
  })

  it('derives the commit style from the subjects on the default branch: form, language, length and ticket key', () => {
    const body = section(HISTORY)
    expect(body).toContain('git log --no-merges --format=%s -n 200 <default branch>')
    for (const measure of ['the conventional form `type(scope): subject` against the free ones', 'the language', 'the median and the longest subject length', 'a ticket key stands in the subject'])
      expect(body).toContain(measure)
  })

  it('states a convention as an observed share with its count, total and command, never as a rule', () => {
    const body = section(HISTORY)
    expect(body).toContain('Each convention is an observation with its share, not a law')
    expect(body).toContain('give the count, the total it is out of, and the command that counted it')
    expect(body).toMatch(/`\d+ of \d+ remote branches \(\d+%\) are [^`]+, counted by git [^`]+`/)
  })

  it('says so when the history is too small or no form holds more than half', () => {
    const body = section(HISTORY)
    expect(body).toContain('With fewer than 20 branches or 20 commits to count, say the history is too small to name a convention, and give the count.')
    expect(body).toContain('When no form holds more than half of what was counted, say there is no convention, and give each form with its share.')
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
