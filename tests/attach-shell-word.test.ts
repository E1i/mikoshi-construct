import type { Ui, Writer } from '../src/ui/console.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { shellWord } from '../src/commands/attach/shell-word.js'
import { ATTACH_CARRIERS } from '../src/presets/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const TEMPLATES = path.join(import.meta.dirname, '../templates/ai/claude')
const CANARY = 'PWNED'
const NEXT_LABEL = 'Next: '
const RERUN_PREFIX = 'npx mikoshi-construct '
const ARGUMENTS_PRINTER = `printf '%s\\0' `

const HOSTILE: Record<string, string> = {
  'a command substitution': `x$(touch ${CANARY})`,
  'a backtick': `x\`touch ${CANARY}\``,
  'a single quote': `it's`,
  'a space': 'a b',
  'a variable': '$HOME',
}

const SAFE_PATHS = ['/tmp/construct-attach/repo', '.claude/commands/plan.md', 'user@host:dir', 'KEY=value']

function sourceOf(target: string): string {
  return path.join(TEMPLATES, target.startsWith('.claude/') ? `_claude/${target.slice('.claude/'.length)}` : target)
}

function capturing(): { ui: Ui, output: () => string } {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  return { ui: createUi(resolveTheme({ plain: true }), write), output: () => text }
}

function nextStep(output: string): string {
  const line = output.split('\n').find(line => line.includes(NEXT_LABEL)) ?? ''
  return line.slice(line.indexOf(NEXT_LABEL) + NEXT_LABEL.length)
}

function repository(parent: string, name: string, carriers: readonly string[]): string {
  const root = path.join(parent, name)
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(path.join(root, 'main.go'), 'package main\n')
  for (const target of carriers) {
    mkdirSync(path.dirname(path.join(root, target)), { recursive: true })
    writeFileSync(path.join(root, target), readFileSync(sourceOf(target)))
  }
  return root
}

function wordsOf(command: string, cwd: string): string[] {
  return execFileSync('sh', ['-c', `${ARGUMENTS_PRINTER}${command}`], { cwd, encoding: 'utf8' }).split('\0').slice(0, -1)
}

function canaryAnywhere(directory: string): boolean {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).some(entry => path.basename(entry) === CANARY)
}

describe('a word attach prints for pasting', () => {
  it.each(SAFE_PATHS)('%s stays bare', (word) => {
    expect(shellWord(word)).toBe(word)
  })

  it.each(Object.entries(HOSTILE))('with %s reads back as the same single word', (_, word) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'construct-shell-word-'))
    expect(wordsOf(shellWord(word), cwd)).toEqual([word])
    expect(canaryAnywhere(cwd)).toBe(false)
  })
})

describe('the collision refusal prints commands a shell runs as written', () => {
  it.each(Object.entries(HOSTILE))('a root with %s: the delete runs no substitution and the rerun names that root', async (_, name) => {
    const parent = mkdtempSync(path.join(tmpdir(), 'construct-shell-root-'))
    const root = repository(parent, name, ATTACH_CARRIERS.targets)
    const { ui, output } = capturing()
    const result = await runAttach(ui, { dir: root, harness: 'true', yes: true })
    expect(result.refusal).toBe('collision')
    const [remove, rerun] = nextStep(output()).split(` && ${RERUN_PREFIX}`)
    execFileSync('sh', ['-c', remove], { cwd: parent })
    expect(canaryAnywhere(parent)).toBe(false)
    expect(ATTACH_CARRIERS.targets.some(target => existsSync(path.join(root, target)))).toBe(false)
    expect(wordsOf(rerun, parent)).toEqual(['attach', '--dir', root, '--yes', '--harness', 'true'])
    expect(canaryAnywhere(parent)).toBe(false)
  })

  it.each(Object.entries(HOSTILE))('a harness with %s: the rerun records exactly the harness given', async (_, word) => {
    const parent = mkdtempSync(path.join(tmpdir(), 'construct-shell-harness-'))
    const root = repository(parent, 'repo', ATTACH_CARRIERS.targets)
    const harness = `echo ${word}`
    const { ui, output } = capturing()
    await runAttach(ui, { dir: root, harness, yes: true })
    const rerun = nextStep(output()).split(` && ${RERUN_PREFIX}`)[1]
    expect(wordsOf(rerun, parent)).toEqual(['attach', '--dir', root, '--yes', '--harness', harness])
    expect(canaryAnywhere(parent)).toBe(false)
  })
})

describe('the not-a-command refusal prints a harness a shell passes as written', () => {
  it.each(Object.entries(HOSTILE))('with %s: each suggestion reads back as one --harness word', async (_, word) => {
    const parent = mkdtempSync(path.join(tmpdir(), 'construct-shell-dead-'))
    const root = repository(parent, 'repo', [])
    const harness = `quality ${word}`
    const { ui, output } = capturing()
    const result = await runAttach(ui, { dir: root, harness, yes: true, env: { PATH: '' } })
    expect(result.refusal).toBe('not-a-command')
    const suggestions = nextStep(output()).split('  or  ').map(suggestion => wordsOf(suggestion, parent))
    expect(suggestions).toEqual([['--harness', `npm run ${harness}`], ['--harness', `npx ${harness}`]])
    expect(canaryAnywhere(parent)).toBe(false)
  })
})
