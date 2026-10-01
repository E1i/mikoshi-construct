import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK = path.resolve(import.meta.dirname, '../.claude/hooks/window-core.mjs')
const CORE_TEXT = '# Window core\n\nwindow-core v1\n\nÅ unicode and `code`\n'
const roots: string[] = []

function project(withCore: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-window-core-'))
  roots.push(root)
  mkdirSync(path.join(root, 'architecture'), { recursive: true })
  if (withCore)
    writeFileSync(path.join(root, 'architecture', 'window-core.md'), CORE_TEXT)
  return root
}

function run(root: string | null) {
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  if (root != null)
    env.CLAUDE_PROJECT_DIR = root
  return spawnSync('node', [HOOK], { input: '{}', env, encoding: 'utf8' })
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('the window-core SessionStart hook', () => {
  it('prints exactly one additionalContext equal to the file text', () => {
    const result = run(project(true))
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CORE_TEXT } })
  })

  it('prints the same bytes on every run', () => {
    const root = project(true)
    expect(run(root).stdout).toBe(run(root).stdout)
  })

  it('refuses loudly, naming the path, when the file is missing', () => {
    const root = project(false)
    const result = run(root)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(path.join(root, 'architecture', 'window-core.md'))
  })

  it('refuses loudly when the project directory is not named', () => {
    const result = run(null)
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('architecture/window-core.md')
  })
})
