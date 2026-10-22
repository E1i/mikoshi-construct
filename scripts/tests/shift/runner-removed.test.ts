import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../..')
const REMOVED_COMMAND = /\bpnpm (?:--silent )?(?:relaunch(?::bg)?|shift(?::(?:bg|current|merge|report))?)(?![\w:-])/
const REMOVED_SCRIPT_NAME = /^(?:relaunch(?::bg)?|shift(?::(?:bg|current|merge|report))?)$/
const REMOVED_RUNNER_WORD = /\b(?:relaunch:bg|shift:(?:bg|current|merge|report))\b/
const REMOVED_FILES = ['shift/shift', 'shift/answer', 'shift/bg', 'shift/current', 'shift/chain-bus', 'shift/notify', 'shift/outcomes', 'shift/report', 'shift/merge', 'shift/relaunch', 'shift/relaunch-bg', 'shift/claude', 'ghosts/cheap-expect']
const IMPORTS_A_REMOVED_FILE = new RegExp(`from '[./]*(?:scripts/)?(?:${REMOVED_FILES.join('|')})\\.js'`)
const RECORDS_OF_PAST_CHANGES = [/^architecture\/decisions\//, /^docs\/release-notes\//, /^\.changeset\//, /^CHANGELOG\.md$/]

function tracked(...paths: string[]): string[] {
  return execFileSync('git', ['-C', root, 'ls-files', '--', ...paths], { encoding: 'utf8' }).split('\n').filter(file => file !== '')
}

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

function offending(files: string[], pattern: RegExp): string[] {
  return files.flatMap(file => read(file).split('\n').flatMap((line, at) => pattern.test(line) ? [`${file}:${at + 1}`] : []))
}

describe('the shift runner is removed', () => {
  it('no package script, workflow, .claude file, template or source file names a removed shift runner command or imports a removed file', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    const sources = tracked('.github', '.claude', 'templates', 'src', 'scripts').filter(file => !file.startsWith('scripts/tests/'))
    expect(Object.entries(scripts).filter(([name, command]) => REMOVED_SCRIPT_NAME.test(name) || REMOVED_COMMAND.test(command))).toEqual([])
    expect(offending(sources, REMOVED_COMMAND)).toEqual([])
    expect(offending(tracked('*.ts', '*.mts', '*.mjs'), IMPORTS_A_REMOVED_FILE)).toEqual([])
  })

  it('no live instruction outside architecture/decisions and the archives leads to the removed runner', () => {
    const live = tracked('*.md').filter(file => !RECORDS_OF_PAST_CHANGES.some(record => record.test(file)))
    expect(offending(live, REMOVED_COMMAND)).toEqual([])
    expect(offending(live, REMOVED_RUNNER_WORD)).toEqual([])
  })
})
