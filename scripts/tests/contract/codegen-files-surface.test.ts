import type { SurfaceReading } from '../../contract/semantic-diff.js'
import type { ContractFormat, Surface } from '../../contract/surface.js'
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
import { CONTRACT_COMMANDS, CONTRACT_FORMATS, formatVersion, GENERATED_SURFACE_FROM, headCommands, SURFACE_VERSION, surfaceBoundaryCode } from '../../contract/surface.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const SURFACE_MODULE = 'scripts/contract/surface.ts'
const PATCH_CHANGESET = '---\n\'mikoshi-construct\': patch\n---\n\nseeded by the compatibility test\n'
const MINOR_CHANGESET = '---\n\'mikoshi-construct\': minor\n---\n\nseeded by the compatibility test\n'
const SEEDED_COMMAND = 'seeded-by-the-compatibility-test'

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
