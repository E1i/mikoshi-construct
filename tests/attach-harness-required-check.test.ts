import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { attachExitOf, readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

useIsolatedHome()

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const CI = 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n'
const env = { PATH: process.env.PATH }

function repository(workflow: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-required-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }))
  if (workflow != null) {
    mkdirSync(path.join(dir, '.github/workflows'), { recursive: true })
    writeFileSync(path.join(dir, '.github/workflows/ci.yml'), workflow)
  }
  return dir
}

describe('attach --harness without --required-check', () => {
  it('records the job whose step runs the same command', async () => {
    const dir = repository(CI)
    const result = await runAttach(ui, { dir, harness: 'npm test', yes: true, env })
    expect(result.status).toBe('done')
    expect(readAttachRecord(dir)?.harness).toEqual({ command: 'npm test', job: 'test' })
  })

  it('refuses when no job runs the command', async () => {
    const dir = repository(CI)
    const result = await runAttach(ui, { dir, harness: 'npm run lint', yes: true, env })
    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('required-check-unresolvable')
    expect(attachExitOf(result)).toBe(2)
    expect(readAttachRecord(dir)).toBeNull()
  })

  it('refuses when there is no workflow at all', async () => {
    const result = await runAttach(ui, { dir: repository(null), harness: 'npm test', yes: true, env })
    expect(result.refusal).toBe('required-check-unresolvable')
  })

  it('an explicit --required-check wins', async () => {
    const dir = repository(null)
    await runAttach(ui, { dir, harness: 'npm test', requiredCheck: 'mine', yes: true, env })
    expect(readAttachRecord(dir)?.harness).toEqual({ command: 'npm test', job: 'mine' })
  })
})
