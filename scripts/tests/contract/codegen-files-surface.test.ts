import type { SurfaceReading } from '../../contract/semantic-diff.js'
import type { ContractFormat, ReportContract, Surface } from '../../contract/surface.js'
import type { AuthorityRule } from '../../policy/policy.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACH_RECORD_VERSION } from '../../../src/commands/attach/record.js'
import { MANIFEST_VERSION } from '../../../src/manifest.js'
import { MODEL_VERSION } from '../../../src/model/schema.js'
import { isWeaker, refReading, requiredLevel } from '../../contract/bump.js'
import { declaredFrom } from '../../contract/declared.js'
import { requiredChange } from '../../contract/semantic-diff.js'
import { CONTRACT_COMMANDS, CONTRACT_FORMATS, exitTables, formatVersion, GENERATED_SURFACE_FROM, headCommands, REPORT_CONTRACT, reportContractRefusals, reportWithoutCountLine, SURFACE_VERSION, surfaceBoundaryCode } from '../../contract/surface.js'
import { MATRIX_COUNT_LINE, pathWithoutMatrix } from '../../policy/policy.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SURFACE_MODULE = 'scripts/contract/surface.ts'
const PATCH_CHANGESET = '---\n\'mikoshi-construct\': patch\n---\n\nseeded by the compatibility test\n'
const MINOR_CHANGESET = '---\n\'mikoshi-construct\': minor\n---\n\nseeded by the compatibility test\n'
const SEEDED_COMMAND = 'seeded-by-the-compatibility-test'
const SYNC_APPLY = 'sync --apply'
const COUNT_LINE = '■ 3 □ 1 · 2'
const CHANGED_PATHS = [['src/manifest.ts'], ['templates/base/AGENTS.md.eta'], ['scripts/contract/surface.ts'], ['scripts/contract/surface.ts', 'templates/ai/x.md'], []]

const surfaceText = readFileSync(path.join(ROOT, SURFACE_MODULE), 'utf8')

function recordedSurface(): Surface {
  return JSON.parse(readFileSync(path.join(ROOT, 'contract/surface.json'), 'utf8')) as Surface
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
}

function readingOf(surface: Surface): SurfaceReading {
  const { surfaceVersion: _, scripts: __, ...sections } = surface
  return sections
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

function gateRefuses(base: Surface, head: Surface, changeset: string): boolean {
  const version = packageVersion()
  const required = requiredLevel(requiredChange(readingOf(base), readingOf(head)).level, version)
  return isWeaker(declaredFrom(version, version, [changeset]), required)
}

describe('file and command boundary code generated from the contract', () => {
  it('file and command boundary code equals what the contract generates', () => {
    const surface = recordedSurface()

    expect(occurrences(surfaceText, GENERATED_SURFACE_FROM)).toBe(1)
    expect(occurrences(surfaceText, surfaceBoundaryCode(surface))).toBe(1)
    expect(surfaceText.indexOf(surfaceBoundaryCode(surface))).toBe(surfaceText.indexOf(GENERATED_SURFACE_FROM))
  })

  it('generates the versions the writers stamp and the commands the command line has', () => {
    const own = Object.entries(headCommands()).filter(([, command]) => 'flags' in command).map(([name]) => name).sort()

    expect(CONTRACT_FORMATS).toEqual({ manifestVersion: MANIFEST_VERSION, modelVersion: MODEL_VERSION, recordVersion: ATTACH_RECORD_VERSION })
    expect([...CONTRACT_COMMANDS].sort()).toEqual(own)
    expect(SURFACE_VERSION).toBe(recordedSurface().surfaceVersion)
  })

  it('the exit tables the code holds are the forms the contract records, sync --apply among them', () => {
    const tables = Object.keys(exitTables()).sort()

    expect(tables).toEqual(Object.keys(recordedSurface().exits).sort())
    expect(tables).toEqual([...CONTRACT_COMMANDS, SYNC_APPLY].sort())
  })

  it('a contract change shows as a difference in the generated code', () => {
    const surface = recordedSurface()
    const grown = { ...surface, formats: { ...surface.formats, manifestVersion: surface.formats.manifestVersion + 1 } }
    const { doctor: _, ...withoutDoctor } = surface.commands

    expect(surfaceBoundaryCode(grown)).not.toBe(surfaceBoundaryCode(surface))
    expect(surfaceBoundaryCode({ ...surface, commands: withoutDoctor })).not.toBe(surfaceBoundaryCode(surface))
    expect(surfaceBoundaryCode({ ...surface, surfaceVersion: surface.surfaceVersion + 1 })).not.toBe(surfaceBoundaryCode(surface))
  })

  it('the generated reader reads a declared format field and refuses a file without it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-format-version-'))
    const file = path.join(dir, 'construct.json')
    writeFileSync(file, JSON.stringify({ manifestVersion: MANIFEST_VERSION }))

    expect(formatVersion(file, 'manifestVersion')).toBe(MANIFEST_VERSION)
    expect(() => formatVersion(file, 'modelVersion')).toThrow('carries no numeric modelVersion')
  })
})

describe('the card report contract', () => {
  it('the report contract is recorded and its reader is the generated code', () => {
    const recorded = recordedSurface().report

    expect(recorded).toEqual({ ...REPORT_CONTRACT, countLineUnder: [...REPORT_CONTRACT.countLineUnder] })
    expect(surfaceText).toContain('export const REPORT_CONTRACT = {')
    expect(surfaceBoundaryCode({ ...recordedSurface(), report: undefined })).not.toContain('REPORT_CONTRACT')
  })

  it('a report whose change touches src/ or templates/ requires the count line, as the merge reads it', () => {
    const refusal: AuthorityRule = REPORT_CONTRACT.countLineRefusal

    expect(refusal).toBe('no_matrix_count_line')
    expect(REPORT_CONTRACT.countLine).toBe(MATRIX_COUNT_LINE.source)
    for (const files of CHANGED_PATHS) {
      for (const report of ['result: done', `result: done\n${COUNT_LINE}`])
        expect(reportWithoutCountLine(report, files), `${files.join(', ')} with ${report}`).toBe(pathWithoutMatrix(report, files))
    }
    expect(reportWithoutCountLine('result: done', ['src/manifest.ts'])).toBe('src/manifest.ts')
    expect(reportWithoutCountLine(`result: done\n${COUNT_LINE}`, ['src/manifest.ts'])).toBeUndefined()
  })

  it('the report contract has a version and a compatibility test', () => {
    const recorded = recordedSurface().report as ReportContract
    const dropped: ReportContract = { ...recorded, countLineUnder: ['src/'] }

    expect(Number.isInteger(recorded.reportVersion) && recorded.reportVersion >= 1).toBe(true)
    expect(reportContractRefusals(undefined, recorded)).toEqual([])
    expect(reportContractRefusals(recorded, recorded)).toEqual([])
    expect(reportContractRefusals(recorded, dropped)).toEqual(['report: the report contract changed without its reportVersion growing'])
    expect(reportContractRefusals(recorded, { ...dropped, reportVersion: recorded.reportVersion + 1 })).toEqual([])
    expect(reportContractRefusals(recorded, { ...recorded, reportVersion: recorded.reportVersion - 1 })).toHaveLength(1)
    expect(surfaceBoundaryCode({ ...recordedSurface(), report: dropped })).not.toBe(surfaceBoundaryCode(recordedSurface()))
  })
})

describe('the versions of the files and surface contracts', () => {
  it('the files and surface contracts have a version and a compatibility test', () => {
    const surface = recordedSurface()

    expect(Number.isInteger(surface.surfaceVersion) && surface.surfaceVersion >= 1).toBe(true)
    for (const field of Object.keys(CONTRACT_FORMATS) as ContractFormat[]) {
      const version = surface.formats[field]
      const grown = { ...surface, formats: { ...surface.formats, [field]: version + 1 } }

      expect(Number.isInteger(version) && version >= 1, field).toBe(true)
      expect(gateRefuses(surface, surface, PATCH_CHANGESET), `${field} unchanged`).toBe(false)
      expect(gateRefuses(surface, grown, PATCH_CHANGESET), `${field} grown under a patch changeset`).toBe(true)
      expect(gateRefuses(surface, grown, MINOR_CHANGESET), `${field} grown under a minor changeset`).toBe(false)
    }

    const { doctor: _, ...withoutDoctor } = surface.commands
    const withSeeded = { ...surface.commands, [SEEDED_COMMAND]: { flags: {} } }
    expect(gateRefuses(surface, { ...surface, commands: withoutDoctor }, PATCH_CHANGESET), 'a command removed under a patch changeset').toBe(true)
    expect(gateRefuses(surface, { ...surface, commands: withoutDoctor }, MINOR_CHANGESET), 'a command removed under a minor changeset').toBe(false)
    expect(requiredChange(readingOf(surface), readingOf({ ...surface, commands: withSeeded })).level).toBe('additive')
  })

  it('a surface of another surfaceVersion is regenerated, never read as the base', () => {
    const surface = recordedSurface()
    const regenerated = { reading: readingOf(surface), note: 'regenerated' }

    expect(refReading(surface, 'base', 'base', () => regenerated).note).not.toBe('regenerated')
    expect(refReading({ ...surface, surfaceVersion: SURFACE_VERSION + 1 }, 'base', 'base', () => regenerated).note).toBe('regenerated')
    expect(refReading({ ...surface, surfaceVersion: SURFACE_VERSION - 1 }, 'base', 'base', () => regenerated).note).toBe('regenerated')
  })
})
