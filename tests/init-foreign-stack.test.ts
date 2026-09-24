import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { runCli } from './cli-process.js'

function goRepository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-go-'))
  writeFileSync(path.join(dir, 'go.mod'), 'module example.com/svc\n\ngo 1.23\n')
  mkdirSync(path.join(dir, 'cmd', 'svc'), { recursive: true })
  writeFileSync(path.join(dir, 'cmd', 'svc', 'main.go'), 'package main\n\nfunc main() {}\n')
  writeFileSync(path.join(dir, 'README.md'), '# svc\n')
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

describe('init refuses a Node preset where the detected stack is another one', () => {
  it('refuses node-backend into a go.mod repository with no package.json and changes nothing', async () => {
    const dir = goRepository()
    const before = snapshot(dir)
    const { status } = await initInto(dir)
    expect(status).toBe('refused')
    expect(snapshot(dir)).toEqual(before)
  })

  it('names the preset and the manifest that contradicts it', async () => {
    const { output } = await initInto(goRepository())
    const refusal = output.split('\n').find(line => line.includes('Refused')) ?? ''
    expect(refusal).toContain('node-backend')
    expect(refusal).toContain('go.mod')
  })

  it('still materializes where a package.json sits beside the go.mod, because Node is then part of the stack', async () => {
    const dir = goRepository()
    writeFileSync(path.join(dir, 'package.json'), '{ "name": "svc" }\n')
    expect((await initInto(dir)).status).toBe('done')
  })

  it('refuses by the manifest, not by the layout: a go.mod repository with a src/ directory is refused too', async () => {
    const dir = goRepository()
    mkdirSync(path.join(dir, 'src'))
    writeFileSync(path.join(dir, 'src', 'lib.go'), 'package src\n')
    expect((await initInto(dir)).status).toBe('refused')
  })

  it('does not refuse an unrecognised layout that has no manifest of any stack', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-docs-'))
    writeFileSync(path.join(dir, 'notes.txt'), 'notes\n')
    expect((await initInto(dir)).status).toBe('done')
  })

  it('exits 1 from the command line', async () => {
    const { status } = await runCli(['init', '--yes', '--preset', 'node-backend', '--dir', goRepository()], mkdtempSync(path.join(tmpdir(), 'construct-home-')))
    expect(status).toBe(1)
  })
})
