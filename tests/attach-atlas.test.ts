import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAtlas } from '../src/atlas/index.js'
import { runAttach } from '../src/commands/attach/index.js'
import { askDetach } from '../src/commands/detach/index.js'
import { ATTACH_CARRIERS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

const ATLAS_CARRIERS = ['.claude/skills/construct-atlas/SKILL.md', '.claude/commands/attached-discover.md']

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function foreignRepository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-atlas-'))
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src/orders.ts'), 'export function place(): void {}\n')
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'shop', private: true })}\n`)
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

function engramFile(): string {
  const root = path.join(home(), '.construct/engram')
  const [entry = ''] = readdirSync(root)
  return path.join(root, entry, 'construct.model.json')
}

describe('the Atlas in an attached repository', () => {
  it('attach writes the atlas carriers as excluded files', async () => {
    const dir = foreignRepository()
    const result = await runAttach(ui, { dir, harness: 'node --version', requiredCheck: 'gate', yes: true })
    expect(result.status).toBe('done')
    expect(ATTACH_CARRIERS.targets).toEqual(expect.arrayContaining(ATLAS_CARRIERS))
    const exclude = readFileSync(path.join(dir, '.git/info/exclude'), 'utf8')
    for (const target of ATLAS_CARRIERS) {
      expect(existsSync(path.join(dir, target)), target).toBe(true)
      expect(exclude, target).toContain(target)
    }
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('names in the attached-discover carrier a command that exists and keeps the interpretation out of the repository', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'node --version', requiredCheck: 'gate', yes: true })
    const discover = readFileSync(path.join(dir, '.claude/commands/attached-discover.md'), 'utf8')
    expect(discover).toContain('construct atlas')
    expect(discover).toContain('~/.construct/engram/')
    expect(readFileSync(path.join(dir, '.claude/skills/construct-atlas/SKILL.md'), 'utf8')).toContain('/attached-discover')
  })

  it('leaves git status empty after the interpretation is written into the Engram', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'node --version', requiredCheck: 'gate', yes: true })
    runAtlas({ dir, home: home(), attached: true })
    const file = engramFile()
    expect(file.startsWith(home())).toBe(true)
    const model = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const components = [{ id: 'orders', contour: '.', name: 'Orders', purpose: 'Places an order', files: ['src/orders.ts'] }]
    writeFileSync(file, `${JSON.stringify({ ...model, interpretation: { authoredBy: 'discovery', components } }, null, 2)}\n`)
    const written = runAtlas({ dir, home: home(), attached: true })
    expect(written.interpreted).toBe(true)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('detach removes the atlas carriers', async () => {
    const dir = foreignRepository()
    await runAttach(ui, { dir, harness: 'node --version', requiredCheck: 'gate', yes: true })
    const result = await askDetach(ui, { dir, yes: true })
    expect(result.status).toBe('done')
    for (const target of ATLAS_CARRIERS)
      expect(existsSync(path.join(dir, target)), target).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })
})
