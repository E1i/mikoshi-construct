import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FACTORY_FOLDERS } from '../scripts/core/factory-paths.js'
import { runInit } from '../src/commands/init.js'
import { FACTORY_MANIFEST, factoryTargetsFor } from '../src/materialize/factory-manifest.js'
import { getPreset, PRESET_IDS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const MIKOSHI_ROOT = path.resolve(import.meta.dirname, '..')

const READ_BY: Record<string, string> = {
  '.claude/agents/brief.md': 'scripts/ladder/ladder.ts',
  '.claude/agents/review.md': 'scripts/ladder/ladder.ts',
  '.claude/agents/scan.md': 'scripts/ladder/ladder.ts',
  '.claude/skills/probe/SKILL.md': 'scripts/nodes/launch/prompt.ts',
  '.claude/eddies.json': 'scripts/cli/board-page.ts',
  '.claude/settings.json': 'scripts/ports/isolation.ts',
  'architecture/owner-merges.md': 'scripts/policy/policy.ts',
  'scripts/construct/check-acceptance.mjs': 'scripts/ladder/hash.ts',
  'scripts/construct/eddies.mjs': '.claude/settings.json',
  'scripts/construct/eddies-measure.mjs': 'scripts/construct/eddies.mjs',
  'scripts/construct/window-heartbeat.mjs': '.claude/settings.json',
  'scripts/construct/window-hooks.mjs': '.claude/settings.json',
}

const NAMED_NOT_CARRIED = {
  'architecture/ghosts-files.md': 'read by the shredder in mikoshi-construct alone, where the Ghost protocol is authored',
  'architecture/window.md': 'cited in a handoff-check message, never read',
  'architecture/code-matrix.md': 'cited in a merge refusal, never read',
  'architecture/model.md': 'matched against a changed path to name its render command, never read',
  'architecture/security-invariants.md': 'matched against a changed path to classify instructions, never read',
} as const

const REPOSITORY_PATH = /(?<![\w~/.-])(\.claude\/[\w./-]+\.(?:md|mjs|json)|scripts\/construct\/[\w.-]+\.(?:mjs|workflow|json)|architecture\/[\w./-]+\.(?:md|yaml|json))/g

function filesUnder(folder: string): string[] {
  const absolute = path.join(MIKOSHI_ROOT, folder)
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .map(file => path.join(absolute, file))
    .filter(file => /\.(?:ts|md)$/.test(file) && statSync(file).isFile())
}

function pathsTheFactoryNames(): Set<string> {
  const named = new Set<string>()
  for (const file of FACTORY_FOLDERS.sharedCode.flatMap(filesUnder)) {
    for (const match of readFileSync(file, 'utf8').matchAll(REPOSITORY_PATH))
      named.add(match[1]!)
  }
  return named
}

function namesTarget(text: string, reader: string, target: string): boolean {
  const quotedSegments = target.split('/').map(segment => `'${segment}'`).join(', ')
  const sibling = path.posix.dirname(reader) === path.posix.dirname(target) && text.includes(`./${path.posix.basename(target)}`)
  return text.includes(target) || text.includes(quotedSegments) || sibling
}

async function initInto(preset: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-factory-manifest-'))
  mkdirSync(path.join(dir, '.git'))
  const ui = createUi(resolveTheme({ plain: true }), silentWriter)
  await runInit(ui, { dir, preset, ai: 'claude', yes: true, dryRun: false, env: {}, home: mkdtempSync(path.join(tmpdir(), 'construct-home-')) })
  return dir
}

const CARRIED = new Set(FACTORY_MANIFEST)

describe('the factory manifest is what init carries for the factory', () => {
  it.each(PRESET_IDS.filter(id => getPreset(id).available))('a fresh %s init puts every file the manifest lists', async (preset) => {
    const dir = await initInto(preset)
    expect(FACTORY_MANIFEST.filter(target => !existsSync(path.join(dir, target)))).toEqual([])
  })

  it('every entry has a reader and every reader names its entry, read from mikoshi-construct or from the tree init wrote', async () => {
    const dir = await initInto('node-backend')
    expect(Object.keys(READ_BY).sort()).toEqual([...FACTORY_MANIFEST].sort())
    const unnamed = FACTORY_MANIFEST.filter((target) => {
      const readBy = READ_BY[target]!
      const reader = path.join(CARRIED.has(readBy) ? dir : MIKOSHI_ROOT, readBy)
      return !namesTarget(readFileSync(reader, 'utf8'), readBy, target)
    })
    expect(unnamed).toEqual([])
  })

  it('every repository path the factory code names is carried, or named without being read in the repository', () => {
    const named = [...pathsTheFactoryNames()]
    expect(named.filter(target => !CARRIED.has(target) && !(target in NAMED_NOT_CARRIED))).toEqual([])
    expect(Object.keys(NAMED_NOT_CARRIED).filter(target => !named.includes(target))).toEqual([])
  })

  it('a repository without the Claude Code runtime owes the factory nothing', () => {
    expect(factoryTargetsFor('cursor')).toEqual([])
    expect(factoryTargetsFor('claude')).toEqual([...CARRIED])
    expect(factoryTargetsFor('both')).toEqual([...CARRIED])
  })
})
