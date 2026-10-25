import type { AdmitResult } from '../src/commands/intake/admit.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { printAdmit, runAdmit } from '../src/commands/intake/admit.js'
import { INTAKE_EXIT, printIntake, runIntake } from '../src/commands/intake/index.js'
import { contourMapFiles, SHARED_CODE_DIRECTORIES, sharedCodeMaskRefusals } from '../src/commands/intake/shared-code-masks.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-22T09:00:00.000Z')
const CARD = '#90 bus-card [implement/netwatch/S/cheap/auto] · depends — · blocks —'
const CONTOUR_MAP = [
  '# Карта',
  '',
  '## Таблица по файлам',
  '',
  '### scripts/ports/ (2 файлов, 300 строк)',
  '',
  '| файл | строк | что делает сейчас |',
  '|---|---:|---|',
  '| disk.ts | 211 | disk |',
  '| github.ts | 89 | github |',
  '',
  '### scripts/core/ (1 файлов, 48 строк)',
  '',
  '| файл | строк | что делает сейчас |',
  '|---|---:|---|',
  '| eddies.ts | 48 | Eddies |',
  '',
  '### bus⇄ghosts',
  '',
  '| цикл | A→B |',
  '|---|---|',
  '| bus⇄ghosts | 35 |',
  '',
].join('\n')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, repo: string, parking: string, contourMap: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-masks-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const file of ['scripts/ports/disk.ts', 'scripts/ports/github.ts', 'scripts/tests/bus/queue.test.ts', 'scripts/core/eddies.ts']) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), '')
  }
  const contourMap = path.join(root, 'contour-map.md')
  writeFileSync(contourMap, CONTOUR_MAP)
  return { root, repo, parking: path.join(root, 'parking'), contourMap }
}

function park(w: World, touches: string, creates?: string): string {
  mkdirSync(w.parking, { recursive: true })
  const file = path.join(w.parking, '90.md')
  writeFileSync(file, `card: ${CARD}\nbranch: feat/bus-card\ntouches: ${touches}\n${creates === undefined ? '' : `creates: ${creates}\n`}continue: stop\nwho: shift\n\nDo the bus thing.\n`)
  return file
}

function admit(w: World, file: string, contourMap = w.contourMap): AdmitResult {
  return runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, contourMap }, () => NOW)
}

function printed(print: (ui: ReturnType<typeof createUi>) => number): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = print(createUi(resolveTheme({ plain: true }), (text: string) => {
    lines.push(text)
  }))
  return { lines, exit }
}

describe('intake refuses a ** mask over shared factory code', () => {
  it('a card with a mask over scripts/ports in touches is not admitted and the refusal names the mask', () => {
    const w = world()
    const result = admit(w, park(w, 'scripts/ports/**'))
    expect(result.status).toBe('sharedCodeMask')
    const { lines, exit } = printed(ui => printAdmit(ui, result))
    expect(exit).toBe(INTAKE_EXIT.refused)
    expect(lines.join('')).toContain(PLAIN_LORE.intakeRefusedSharedCodeMask)
    expect(lines.join('')).toContain('\'scripts/ports/**\'')
    expect(lines.join('')).toContain('scripts/ports/disk.ts, scripts/ports/github.ts')
  })

  it('the same card with concrete files under scripts/ports is admitted', () => {
    const w = world()
    expect(admit(w, park(w, 'scripts/ports/disk.ts, scripts/ports/github.ts')).status).toBe('admitted')
  })

  it('a mask over scripts/tests is admitted', () => {
    const w = world()
    expect(admit(w, park(w, 'scripts/ports/github.ts, scripts/tests/**, .changeset/**')).status).toBe('admitted')
  })

  it('a mask over a new directory named in creates is admitted', () => {
    const w = world()
    expect(admit(w, park(w, 'scripts/ports/fresh/**', 'scripts/ports/fresh')).status).toBe('admitted')
  })

  it('a mask over a parent of shared code is refused as well', () => {
    expect(sharedCodeMaskRefusals(['scripts/**'], [], null)).toEqual(['touches entry \'scripts/**\' masks shared code; name the files the change edits'])
  })

  it('a mask outside shared code is admitted', () => {
    expect(sharedCodeMaskRefusals(['docs/**', 'scripts/release/**', 'tests/**'], [], null)).toEqual([])
  })

  it('names the mask alone when the contour map cannot be read', () => {
    const w = world()
    const result = admit(w, park(w, 'scripts/core/**'), path.join(w.root, 'absent.md'))
    expect(result).toEqual({ status: 'sharedCodeMask', reasons: ['touches entry \'scripts/core/**\' masks shared code; name the files the change edits'] })
  })

  it('proposes only the files the contour map lists under the masked directory', () => {
    expect(contourMapFiles(CONTOUR_MAP, 'scripts/core')).toEqual(['scripts/core/eddies.ts'])
    expect(contourMapFiles(CONTOUR_MAP, 'scripts')).toEqual(['scripts/ports/disk.ts', 'scripts/ports/github.ts', 'scripts/core/eddies.ts'])
  })

  it('every shared directory is one this repository has', () => {
    expect(SHARED_CODE_DIRECTORIES.filter(directory => !existsSync(directory))).toEqual([])
  })

  it('a draft with a mask over shared code parks nothing', () => {
    const w = world()
    const draft = path.join(w.root, 'draft.json')
    writeFileSync(draft, JSON.stringify({ cards: [{ name: 'bus-card', kind: 'implement', milestone: 'netwatch', size: 'S', contour: 'cheap', touches: ['scripts/ports/**'], task: 'Do it.', witnesses: ['`true` passes'] }] }))
    const result = runIntake({ draft, taken: '-', parking: w.parking, parkingRoot: w.parking, contourMap: w.contourMap, dir: w.repo, dryRun: false, autoConfirm: true, readStdin: () => '' })
    expect(result).toMatchObject({ status: 'refused', refusal: 'sharedCodeMask' })
    const { lines, exit } = printed(ui => printIntake(ui, result))
    expect(exit).toBe(INTAKE_EXIT.refused)
    expect(lines.join('')).toContain('\'scripts/ports/**\'')
  })
})
