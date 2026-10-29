import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { remoteHostOf } from '../src/commands/attach/forge.js'
import { readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

useIsolatedHome()

const env = { PATH: process.env.PATH }

function repository(remote: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attachforge-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  if (remote != null)
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }))
  return dir
}

function capturing(): { ui: ReturnType<typeof createUi>, printed: () => string } {
  const lines: string[] = []
  return { ui: createUi(resolveTheme({ plain: true }), text => lines.push(text)), printed: () => lines.join('') }
}

const HOSTS: Record<string, string | null> = {
  'https://github.com/o/r.git': 'github.com',
  'git@github.com:o/r.git': 'github.com',
  'ssh://git@GitLab.example.com:2222/o/r.git': 'gitlab.example.com',
  'https://user@gitea.example.org/o/r': 'gitea.example.org',
  'git@gogs.local:o/r.git': 'gogs.local',
  '/srv/git/r.git': null,
  'file:///srv/git/r.git': null,
  '../r.git': null,
}

describe('remoteHostOf reads the host of a remote url', () => {
  for (const [url, host] of Object.entries(HOSTS)) {
    it(`${url} → ${host ?? 'no host'}`, () => {
      expect(remoteHostOf(url)).toBe(host)
    })
  }
})

describe('attach off GitHub', () => {
  it('attach to a non-GitHub remote says the factory is unavailable', async () => {
    const dir = repository('git@gitlab.example.com:o/r.git')
    const { ui, printed } = capturing()
    const result = await runAttach(ui, { dir, harness: 'npm test', yes: true, env })
    expect(result.status).toBe('done')
    expect(printed()).toContain(PLAIN_LORE.attachFactoryUnavailable('gitlab.example.com'))
    const record = readAttachRecord(dir)
    expect(record?.harness).toBe('none')
    expect(record?.factoryBeside).toBeUndefined()
  })

  it('a GitHub remote keeps the harness and its required check', async () => {
    const dir = repository('https://github.com/o/r.git')
    const { ui, printed } = capturing()
    const result = await runAttach(ui, { dir, harness: 'npm test', requiredCheck: 'test', yes: true, env })
    expect(result.status).toBe('done')
    expect(printed()).not.toContain(PLAIN_LORE.attachFactoryUnavailable('github.com'))
    expect(readAttachRecord(dir)?.harness).toEqual({ command: 'npm test', job: 'test' })
  })
})

describe('the required check', () => {
  it('the required-check refusal names harness none', async () => {
    const dir = repository(null)
    const { ui, printed } = capturing()
    const result = await runAttach(ui, { dir, harness: 'npm test', yes: true, env })
    expect(result.refusal).toBe('required-check-unresolvable')
    expect(printed()).toContain('--harness none')
  })

  it('--harness none attaches without a gate and asks for no check', async () => {
    const dir = repository(null)
    const result = await runAttach(capturing().ui, { dir, harness: 'none', yes: true, env })
    expect(result.status).toBe('done')
    expect(readAttachRecord(dir)?.harness).toBe('none')
  })
})
