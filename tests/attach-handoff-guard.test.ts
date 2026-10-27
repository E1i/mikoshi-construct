import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { WINDOW_ENTRIES } from '../src/commands/attach/settings.js'

const TWINS = [
  path.join(import.meta.dirname, '../templates/ai/claude/scripts/construct/window-hooks.mjs'),
  path.join(import.meta.dirname, '../templates/attach/_construct/window-hooks.mjs'),
]
const REASON = 'write the handoff with miko handoff write <name> <draft>'
const HANDOFF_DIR = '/home/someone/.construct/owner--repo/handoff'

function preToolUse(template: string, filePath: unknown, extra: Record<string, string> = {}): string {
  const { CONSTRUCT_CARD: _card, CONSTRUCT_BUS_RAISED: _raised, CLAUDE_CODE_ENTRYPOINT: _entrypoint, CONSTRUCT_HANDOFF: _handoff, ...rest } = process.env
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-handoff-guard-'))
  const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } })
  const env = { ...rest, CONSTRUCT_HANDOFF_DIR: HANDOFF_DIR, CLAUDE_PROJECT_DIR: dir, ...extra }
  return spawnSync(process.execPath, [template, 'pre-tool-use'], { cwd: dir, input, encoding: 'utf8', env }).stdout
}

describe.each(TWINS)('the window hook of %s guards the handoff directory', (template) => {
  it('a write into the handoff directory is denied with the command to use', () => {
    expect(JSON.parse(preToolUse(template, `${HANDOFF_DIR}/miko.md`))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON },
    })
  })

  it('a path below the handoff directory is denied', () => {
    expect(preToolUse(template, `${HANDOFF_DIR}/drafts/next.md`)).toContain('"permissionDecision":"deny"')
  })

  it('a write outside the handoff directory is let through', () => {
    expect(preToolUse(template, '/work/repo/src/a.ts')).toBe('')
    expect(preToolUse(template, `${HANDOFF_DIR}-other/miko.md`)).toBe('')
  })

  it('a call without a file path is let through', () => {
    expect(preToolUse(template, undefined)).toBe('')
  })

  it('a card session is never guarded', () => {
    expect(preToolUse(template, `${HANDOFF_DIR}/miko.md`, { CONSTRUCT_CARD: '1' })).toBe('')
  })
})

describe('attach registers the guard on the three writing tools', () => {
  it('the PreToolUse window entry carries the matcher', () => {
    expect(WINDOW_ENTRIES.PreToolUse).toMatchObject({ matcher: 'Write|Edit|MultiEdit' })
  })
})
