import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { CONTRACT_COMMANDS, CONTRACT_FORMATS } from '../../contract/surface.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const PROBE = 'scripts/nodes/probe/hand-surface-boundary.ts'
const TEST_PROBE = 'scripts/tests/bus/hand-surface-boundary-probe.test.ts'
const GENERATOR_PROBE = 'scripts/contract/hand-surface-boundary-probe.ts'
const RULE = 'contract/no-hand-written-surface-boundary'

const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const {
  HAND_SURFACE_BOUNDARIES_EXCEPTED: EXCEPTED,
  SURFACE_COMMAND_NAMES,
  SURFACE_FORMAT_FIELDS,
  COMMAND_NAMES_THAT_MAKE_A_LIST,
} = await import(CONFIG_URL) as {
  HAND_SURFACE_BOUNDARIES_EXCEPTED: string[]
  SURFACE_COMMAND_NAMES: string[]
  SURFACE_FORMAT_FIELDS: string[]
  COMMAND_NAMES_THAT_MAKE_A_LIST: number
}

const eslint = new ESLint({ cwd: REPO_ROOT })

async function handBoundaries(source: string, file = PROBE): Promise<number[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, file) })
  return result!.messages.filter(message => message.ruleId === RULE).map(message => message.line)
}

describe('hand-written boundary code for files and commands is forbidden by lint', () => {
  it('lint refuses a hand-written command boundary', async () => {
    const source = [
      'export const OWN = [\'init\', \'attach\', \'sync\']',
      'export const EXITS = { doctor: 0, soulkill: 1, graph: 2 }',
      'export type Own = \'init\' | \'doctor\' | \'cost\'',
      '',
    ].join('\n')
    expect(await handBoundaries(source)).toEqual([1, 2, 3])
  })

  it('lint refuses a hand-written read of a contract file version', async () => {
    const source = [
      'export function versions(text: string): unknown[] {',
      '  const model = JSON.parse(text) as { modelVersion?: unknown }',
      '  const manifest = JSON.parse(text).manifestVersion',
      '  const record = (JSON.parse(text) as Record<string, unknown>)[\'recordVersion\']',
      '  return [model, manifest, record]',
      '}',
      '',
    ].join('\n')
    expect(await handBoundaries(source)).toEqual([2, 3, 4])
  })

  it('commands and versions read through the generated surface are not a hand boundary', async () => {
    const source = [
      'import { CONTRACT_COMMANDS, formatVersion } from \'../../contract/surface.js\'',
      'export const others = CONTRACT_COMMANDS.filter(command => command !== \'init\')',
      'export const version = (file: string): number => formatVersion(file, \'manifestVersion\')',
      'export interface Page { modelVersion: number | null }',
      'export const shown = (page: Page): string => String(page.modelVersion)',
      '',
    ].join('\n')
    expect(await handBoundaries(source)).toEqual([])
  })

  it(`fewer than ${COMMAND_NAMES_THAT_MAKE_A_LIST} command names in one literal are not a command list`, async () => {
    expect(await handBoundaries('export const PAIR = [\'init\', \'sync\', \'lint\', \'typecheck\']\n')).toEqual([])
  })

  it('a test under scripts/tests and the generator under scripts/contract may write the boundary by hand', async () => {
    const source = 'export const OWN = [\'init\', \'attach\', \'sync\']\n'
    expect(await handBoundaries(source, TEST_PROBE)).toEqual([])
    expect(await handBoundaries(source, GENERATOR_PROBE)).toEqual([])
  })

  it('the rule reads its commands and fields from the contract the generated code comes from', () => {
    expect(SURFACE_COMMAND_NAMES).toEqual([...CONTRACT_COMMANDS].sort())
    expect(SURFACE_FORMAT_FIELDS).toEqual(Object.keys(CONTRACT_FORMATS).sort())
  })

  it('lists each excepted file once, in order', () => {
    expect(EXCEPTED).toEqual([...new Set(EXCEPTED)].sort())
  })

  it('every excepted file still writes a boundary by hand', async () => {
    const fixed: string[] = []
    for (const file of EXCEPTED) {
      const absolute = path.join(REPO_ROOT, file)
      if (!existsSync(absolute) || (await handBoundaries(readFileSync(absolute, 'utf8'))).length === 0)
        fixed.push(file)
    }
    expect(fixed).toEqual([])
  })

  it('the rule stands aside for every excepted file', async () => {
    for (const file of EXCEPTED) {
      const [result] = await eslint.lintText(readFileSync(path.join(REPO_ROOT, file), 'utf8'), { filePath: path.join(REPO_ROOT, file) })
      expect(result!.messages.filter(message => message.ruleId === RULE), file).toEqual([])
    }
  })
})
