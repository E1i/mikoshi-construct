import type { Ui, Writer } from '../src/ui/console.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyCollisions, knownCarriers } from '../src/commands/attach/earlier.js'
import { runAttach } from '../src/commands/attach/index.js'
import { ATTACH_CARRIERS } from '../src/presets/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const TEMPLATES = path.join(import.meta.dirname, '../templates/ai/claude')
const HARNESS = 'true'
const PLAN = '.claude/commands/plan.md'
const ARCHITECT = '.claude/agents/architect.md'
const HARNESS_AGENT = '.claude/agents/harness.md'
const OWNER_BYTES = '# mine\n'

function sourceOf(target: string): string {
  return path.join(TEMPLATES, target.startsWith('.claude/') ? `_claude/${target.slice('.claude/'.length)}` : target)
}

function todaysBytes(target: string): Buffer {
  return readFileSync(sourceOf(target))
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function repository(files: Record<string, Buffer | string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-earlier-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(path.join(dir, 'main.go'), 'package main\n')
  for (const [target, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, target)), { recursive: true })
    writeFileSync(path.join(dir, target), content)
  }
  return dir
}

function capturing(name: 'plain' | 'arasaka'): { ui: Ui, output: () => string } {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  return { ui: createUi({ ...resolveTheme({ plain: true }), name }, write), output: () => text }
}

function removeLine(output: string): string {
  return output.split('\n').find(line => line.includes('rm -- ')) ?? ''
}

function deleteCommand(output: string): string {
  const line = removeLine(output)
  return line.slice(line.indexOf('cd '), line.indexOf(' && npx'))
}

function removedPaths(output: string): string[] {
  const line = removeLine(output)
  const start = line.indexOf('rm -- ') + 'rm -- '.length
  const end = [' && npx', ' removes'].map(marker => line.indexOf(marker)).filter(index => index > start)
  return line.slice(start, Math.min(...end)).split(' ')
}

describe('the known set of earlier carriers', () => {
  it('holds the template of today for every carrier', () => {
    const known = knownCarriers()
    for (const target of ATTACH_CARRIERS.targets)
      expect(known.some(entry => entry.target === target && entry.sha256 === sha256(todaysBytes(target)))).toBe(true)
  })

  it('names only carrier targets, each pair once, each with a sha256 and a date and nothing else', () => {
    const known = knownCarriers()
    const targets: readonly string[] = ATTACH_CARRIERS.targets
    expect(known.every(entry => targets.includes(entry.target))).toBe(true)
    expect(known.every(entry => Object.keys(entry).sort().join() === 'date,sha256,target')).toBe(true)
    expect(known.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256) && /^\d{4}-\d{2}-\d{2}$/.test(entry.date))).toBe(true)
    expect(new Set(known.map(entry => `${entry.target} ${entry.sha256}`)).size).toBe(known.length)
  })
})

describe('classifyCollisions', () => {
  it('recognises a carrier byte for byte a template and not an owner file', () => {
    const root = repository({ [PLAN]: todaysBytes(PLAN), [ARCHITECT]: OWNER_BYTES })
    const [plan, architect] = classifyCollisions(root, [PLAN, ARCHITECT])
    expect(plan?.target).toBe(PLAN)
    expect(plan?.sha256).toBe(sha256(todaysBytes(PLAN)))
    expect(architect).toBeNull()
  })

  it('does not recognise a template at another carrier path, nor a template with one byte added', () => {
    const root = repository({ [ARCHITECT]: todaysBytes(PLAN), [PLAN]: Buffer.concat([todaysBytes(PLAN), Buffer.from('\n')]) })
    expect(classifyCollisions(root, [ARCHITECT, PLAN])).toEqual([null, null])
  })

  it('does not recognise a symlink to template bytes, a directory, or a path that is not a carrier', () => {
    const root = repository({ 'elsewhere/plan.md': todaysBytes(PLAN), 'README.md': todaysBytes(PLAN) })
    mkdirSync(path.join(root, '.claude/commands'), { recursive: true })
    symlinkSync(path.join(root, 'elsewhere/plan.md'), path.join(root, PLAN))
    mkdirSync(path.join(root, ARCHITECT), { recursive: true })
    expect(classifyCollisions(root, [PLAN, ARCHITECT, 'README.md'])).toEqual([null, null, null])
  })
})

describe('the collision refusal', () => {
  it.each(['plain', 'arasaka'] as const)('prints the delete-and-rerun command in the %s theme, and running it lets attach through', async (name) => {
    const files = Object.fromEntries(ATTACH_CARRIERS.targets.map(target => [target, todaysBytes(target)]))
    const root = repository(files)
    const { ui, output } = capturing(name)
    const result = await runAttach(ui, { dir: root, harness: HARNESS, yes: true })
    expect(result.refusal).toBe('collision')
    expect(removedPaths(output())).toEqual([...ATTACH_CARRIERS.targets])
    expect(output()).toContain(`cd ${root} && rm -- `)
    expect(output()).toContain(`npx mikoshi-construct attach --dir ${root} --yes --harness true`)
    execFileSync('sh', ['-c', deleteCommand(output())])
    const again = await runAttach(capturing(name).ui, { dir: root, harness: HARNESS, yes: true })
    expect(again.status).toBe('done')
  })

  it('never puts a file that is not recognised on the delete line, and leaves it byte for byte', async () => {
    const root = repository({ [PLAN]: todaysBytes(PLAN), [HARNESS_AGENT]: OWNER_BYTES })
    const { ui, output } = capturing('plain')
    await runAttach(ui, { dir: root, harness: HARNESS, yes: true })
    expect(removedPaths(output())).toEqual([PLAN])
    expect(removeLine(output())).not.toContain('harness.md')
    expect(output()).toContain(`${HARNESS_AGENT}  not recognised: attach never writes over it`)
    expect(readFileSync(path.join(root, HARNESS_AGENT), 'utf8')).toBe(OWNER_BYTES)
  })

  it('prints no delete command when no colliding file is recognised', async () => {
    const root = repository({ [PLAN]: OWNER_BYTES })
    const { ui, output } = capturing('plain')
    await runAttach(ui, { dir: root, harness: HARNESS, yes: true })
    expect(output()).not.toContain('rm --')
    expect(output()).toContain(`Move or remove them yourself, then run: npx mikoshi-construct attach --dir ${root} --yes --harness true`)
    expect(existsSync(path.join(root, PLAN))).toBe(true)
  })
})
