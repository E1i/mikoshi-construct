import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsPaths } from '../../ports/isolation.js'

const REPO = path.resolve(import.meta.dirname, '../../..')
const PROJECT_SETTINGS = path.relative(REPO, settingsPaths({}, REPO, process.platform, homedir()).project)
const WINDOW_RULES = readFileSync(path.join(REPO, 'architecture', 'window.md'), 'utf8')

function sectionOf(heading: string): string {
  const start = WINDOW_RULES.indexOf(`\n## ${heading}\n`)
  expect(start, `architecture/window.md has no section ${heading}`).toBeGreaterThanOrEqual(0)
  const end = WINDOW_RULES.indexOf('\n## ', start + 1)
  return WINDOW_RULES.slice(start, end)
}

function trackedSettingsFiles(): string[] {
  return execFileSync('git', ['-C', REPO, 'ls-files', '*settings*.json'], { encoding: 'utf8' }).split('\n').filter(Boolean)
}

describe('a pull request reaches main through the bus', () => {
  it('the window rules tell the window to arm no auto-merge and to update no branch', () => {
    const section = sectionOf('Pull requests and branches')
    expect(section).not.toMatch(/--auto|auto-merge|update-branch/)
    expect(section).toContain('the bus update node updates the branch and carries\na review, and the bus merges')
    expect(section).toContain('the merge queue withdraws one without that line')
    expect(WINDOW_RULES).not.toMatch(/gh pr (?:merge[^\n]*--auto|update-branch)/)
  })

  it('the history of the auto-merge rule stays on record', () => {
    expect(WINDOW_RULES).toContain('| allow-auto-merge, PR #365 |')
    expect(WINDOW_RULES).toContain('decisions/0052-an-approval-carries-a-regeneration-and-a-review-carries-a-clean-update-branch.md')
  })

  it('no tracked settings file permits auto-merge or update-branch', () => {
    const files = trackedSettingsFiles()
    expect(files).toEqual(expect.arrayContaining([PROJECT_SETTINGS, 'templates/ai/claude/_claude/settings.json']))
    const permitting = files.filter(file => /--auto|update-branch/.test(readFileSync(path.join(REPO, file), 'utf8')))
    expect(permitting).toEqual([])
  })

  it('the boundary paragraph names no merged pull request as a stop', () => {
    const paragraph = sectionOf('The boundary').trim().split('\n\n')[1]!
    expect(paragraph).not.toMatch(/merged|merge half/)
    expect(paragraph).not.toMatch(/reaches `contextLimit`/)
    for (const stop of ['`stopReasonOf`', '`contextLimit` ×\n`warnRatio`', '`cardContextLine`', '`sessionSpend` × `warnRatio`', 'a core change', '`STATUS: DONE`'])
      expect(paragraph).toContain(stop)
  })
})
