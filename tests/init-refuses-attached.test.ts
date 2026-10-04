import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

function repository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attached-'))
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "svc" }\n')
  writeFileSync(path.join(dir, 'README.md'), '# svc\n')
  return dir
}

function attached(record: string): string {
  const dir = repository()
  mkdirSync(path.join(dir, '.construct'))
  writeFileSync(path.join(dir, '.construct', 'attach.json'), record)
  return dir
}

function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(entry.parentPath, entry.name)
    entries[path.relative(dir, absolute)] = entry.isDirectory() ? '<dir>' : readFileSync(absolute, 'utf8')
  }
  return entries
}

async function initInto(dir: string): Promise<{ status: string, output: string }> {
  let output = ''
  const ui = createUi(resolveTheme({ plain: true }), (chunk) => {
    output += chunk
  })
  const result = await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
  return { status: result.status, output }
}

describe('init refuses a repository that attach already holds', () => {
  it('refuses where .construct/attach.json is a readable record, names the reason and changes no byte', async () => {
    const dir = attached('{ "recordVersion": 2, "files": {}, "directories": [] }\n')
    const before = snapshot(dir)
    const { status, output } = await initInto(dir)
    expect(status).toBe('refused')
    expect(output).toContain(PLAIN_LORE.initRefusedAttached)
    expect(snapshot(dir)).toEqual(before)
  })

  it('refuses by the presence of the record, not its content: an unreadable attach.json is refused the same way', async () => {
    const dir = attached('{ not json')
    const before = snapshot(dir)
    const { status, output } = await initInto(dir)
    expect(status).toBe('refused')
    expect(output).toContain(PLAIN_LORE.initRefusedAttached)
    expect(snapshot(dir)).toEqual(before)
  })

  it('materializes a repository with no .construct/', async () => {
    expect((await initInto(repository())).status).toBe('done')
  })

  it('does not refuse an empty .construct/ with no attach.json in it', async () => {
    const dir = repository()
    mkdirSync(path.join(dir, '.construct'))
    expect((await initInto(dir)).status).toBe('done')
  })
})
