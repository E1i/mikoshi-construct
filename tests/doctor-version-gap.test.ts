import type { PathClassification } from '../src/sync/classify.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

let reclassify: (classifications: PathClassification[]) => PathClassification[] = entries => entries

vi.mock('../src/sync/classify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync/classify.js')>()
  return {
    ...actual,
    classifyRepository: (state: Parameters<typeof actual.classifyRepository>[0]) => reclassify(actual.classifyRepository(state)),
  }
})

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-gap-'))
}

async function materialized(): Promise<string> {
  const dir = scratch()
  await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
  return dir
}

function rendered(root: string, version: string): { output: string, code: number } {
  const lines: string[] = []
  const console = createUi(resolveTheme({ plain: true }), text => lines.push(text))
  const code = printDoctor(console, runDoctor(root, version))
  return { output: lines.join(''), code }
}

beforeEach(() => {
  reclassify = entries => entries
})

describe('the version gap doctor reports', () => {
  it('names the version that materialized the repository and the version reading it', async () => {
    const dir = await materialized()
    const result = runDoctor(dir, '9.9.9')
    expect(result?.versionGap.materializedBy).toBe(VERSION)
    expect(result?.versionGap.readBy).toBe('9.9.9')
    expect(rendered(dir, '9.9.9').output).toContain(PLAIN_LORE.syncVersionGap(VERSION, '9.9.9'))
  })

  it('counts what a sync would add or update from the sync engine\'s own classification', async () => {
    const dir = await materialized()
    expect(runDoctor(dir, VERSION)?.versionGap.pending).toBe(0)

    reclassify = entries => entries.map((entry, index) => (index === 0 ? { ...entry, class: 'add' as const } : entry))
    expect(runDoctor(dir, VERSION)?.versionGap.pending).toBe(1)

    reclassify = entries => entries.map(entry => (entry.class === 'keep' ? { ...entry, class: 'update' as const } : entry))
    const everyKeptPathPending = runDoctor(dir, VERSION)?.versionGap.pending ?? 0
    expect(everyKeptPathPending).toBeGreaterThan(1)
  })

  it('reads the count back as evidence beside the baseline, and never as a gate', async () => {
    const dir = await materialized()
    const current = rendered(dir, VERSION)
    expect(current.output).toContain(PLAIN_LORE.baselineCurrent)
    expect(current.code).toBe(0)

    reclassify = entries => entries.map((entry, index) => (index === 0 ? { ...entry, class: 'add' as const } : entry))
    const moved = rendered(dir, VERSION)
    expect(moved.output).toContain(PLAIN_LORE.baselineMoved(1))
    expect(moved.code).toBe(0)
    expect(runDoctor(dir, VERSION)?.ok).toBe(true)
    expect(runDoctor(dir, VERSION)?.checks).toHaveLength(2)
  })

  it('says the gap cannot be established rather than failing when the replay cannot run', async () => {
    const dir = await materialized()
    reclassify = () => {
      throw new Error('the replay cannot render this manifest')
    }
    const { output, code } = rendered(dir, VERSION)
    expect(runDoctor(dir, VERSION)?.versionGap.pending).toBeNull()
    expect(output).toContain(PLAIN_LORE.baselineGapUnknown)
    expect(code).toBe(0)
  })
})
