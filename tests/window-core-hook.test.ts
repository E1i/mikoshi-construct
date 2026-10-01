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

  function refusal(result: ReturnType<typeof run>) {
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(1)
    const output = JSON.parse(lines[0])
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(output.hookSpecificOutput.additionalContext.startsWith('WINDOW-CORE MISSING: DO NOT COMMIT. DO NOT MERGE. STOP.\n')).toBe(true)
    expect(output.systemMessage.startsWith('WINDOW-CORE MISSING: DO NOT COMMIT. DO NOT MERGE. STOP.')).toBe(true)
    return output
  }

  it('tells the model and the owner to stop, naming the path, when the file is missing', () => {
    const root = project(false)
    const result = run(root)
    const output = refusal(result)
    const file = path.join(root, 'architecture', 'window-core.md')
    expect(output.hookSpecificOutput.additionalContext).toContain(file)
    expect(output.systemMessage).toContain(file)
    expect(result.stderr).toContain(file)
  })

  it('tells the model and the owner to stop when the project directory is not named', () => {
    const result = run(null)
    const output = refusal(result)
    expect(output.hookSpecificOutput.additionalContext).toContain('architecture/window-core.md')
    expect(result.stderr).toContain('architecture/window-core.md')
  })
})
