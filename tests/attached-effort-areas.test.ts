import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeExcludeBlock } from '../src/commands/attach/exclude.js'
import { ATTACH_RECORD_FILE } from '../src/commands/attach/record.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const AREAS_FILE = '.construct/high-effort-areas.md'
const SKILL = 'templates/ai/claude/_claude/skills/implement/SKILL.md'
const PROTOCOL = 'templates/ai/shared/_claude/commands/construct-discover.md'
const NOT_RECORDED = 'high-effort areas not recorded'

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

describe('an attached repository records its high-effort areas in .construct and /implement reads them there', () => {
  it('names the areas file and the attach record in the implement skill', () => {
    const skill = read(SKILL)
    expect(skill).toContain(AREAS_FILE)
    expect(skill).toContain(ATTACH_RECORD_FILE)
  })

  it('tells /implement what to say when an attached repository has no areas file', () => {
    expect(read(SKILL)).toContain(NOT_RECORDED)
  })

  it('has discovery write the areas file when there is an attach record and no construct.json', () => {
    const protocol = read(PROTOCOL)
    expect(protocol).toContain(AREAS_FILE)
    expect(protocol).toContain(ATTACH_RECORD_FILE)
    expect(protocol.replace(/\s+/g, ' ')).toContain('write nothing outside `.construct/`')
  })

  it('keeps this repository\'s copies of the skill and the discovery protocol identical to the templates', () => {
    expect(read('.claude/skills/implement/SKILL.md')).toBe(read(SKILL))
    expect(read('.claude/commands/construct-discover.md')).toBe(read(PROTOCOL))
  })

  it('leaves the areas file out of git status once attach has written its exclude block', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-areas-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeExcludeBlock(dir, [])
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, AREAS_FILE), '- src/billing/ — money\n')
    expect(spawnSync('git', ['check-ignore', '-q', AREAS_FILE], { cwd: dir }).status).toBe(0)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe('')
  })
})
