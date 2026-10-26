import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseTaskFile } from '../../../src/card/task-file.js'
import { runInit } from '../../../src/commands/init.js'
import { publishedRootsOf } from '../../../src/commands/intake/check.js'
import { readManifest, readShiftGate } from '../../../src/manifest.js'
import { createUi, silentWriter } from '../../../src/ui/console.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { treeReportPath } from '../../core/places.js'
import { renderPrompt } from '../../nodes/launch/prompt.js'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..')
const HEADER = readFileSync(path.join(PACKAGE_ROOT, 'scripts/nodes/launch/header.md'), 'utf8')
const PUBLISHED_ROOTS = publishedRootsOf(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) ?? []
const RELATIVE_PATH = /^[\w.@-]+(?:\/[\w.@*-]+)+$/
const RUN_SCRIPT = /^pnpm run (\S+)$/
const BRANCH = 'feat/task-7'
const GIT_REFS = new Set([BRANCH, 'origin/main'])

function namedPaths(prompt: string): string[] {
  const quoted = [...prompt.matchAll(/`([^`]+)`/g)].map(match => match[1]!)
  return [...new Set(quoted.flatMap(text => text.split(/\s+/)).filter(token => RELATIVE_PATH.test(token) && !GIT_REFS.has(token)))]
}

function shippedByPackage(relative: string): boolean {
  return PUBLISHED_ROOTS.some(root => relative === root || relative.startsWith(`${root}/`)) && existsSync(path.join(PACKAGE_ROOT, relative))
}

function implementTask(): ReturnType<typeof parseTaskFile> {
  return parseTaskFile('07.md', `card: #7 task-7 [implement/runner/S/cheap/auto] · depends — · blocks —\nbranch: ${BRANCH}\ntouches: package.json\n\nDo it.\n`)
}

describe('the shift prompt built for a repository after construct init --preset node-library', () => {
  let dir = ''
  let prompt = ''

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'construct-shift-prompt-'))
    await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-library', name: 'shift-prompt-fixture', yes: true, dryRun: false })
    const parsed = implementTask()
    if (parsed.kind === 'refused')
      throw new Error(parsed.reason)
    prompt = renderPrompt(HEADER, parsed.task, { worktree: dir, report: treeReportPath(dir), gate: readShiftGate(dir) })
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('names no path that exists neither in that repository nor in what the package ships', () => {
    const missing = namedPaths(prompt).filter(relative => !existsSync(path.join(dir, relative)) && !shippedByPackage(relative))
    expect(missing).toEqual([])
  })

  it('names none of this repository\'s own scripts, its code matrix or its handoff command', () => {
    for (const own of ['scripts/ci/prepush.ts', 'scripts/window/handoff-check.ts', 'architecture/code-matrix.md', 'pnpm handoff:write'])
      expect(prompt).not.toContain(own)
  })

  it('names as its pre-push check the harness command init wrote, a script the repository\'s package.json declares', () => {
    const command = readManifest(dir)!.harness.command
    expect(readShiftGate(dir).prepush).toEqual([command])
    expect(prompt).toContain(`\`${command}\``)
    const script = RUN_SCRIPT.exec(command)?.[1]
    const scripts = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
    expect(script === undefined ? undefined : scripts[script]).toBeTypeOf('string')
  })
})
