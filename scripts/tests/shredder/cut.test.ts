import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldCalleesIntoCallers } from '../../shredder/cut.js'

const CLI = path.join(import.meta.dirname, '..', '..', 'shredder', 'cli.ts')
const ATLAS_CUT = path.join(import.meta.dirname, 'cut-fixtures', 'atlas.json')
const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')

const engram = { id: 'engram', defines: ['writeEngram'], calls: ['detect'] }
const renderer = { id: 'renderer', defines: ['renderAtlas'], calls: [] }
const command = { id: 'command', defines: ['runAtlas'], calls: ['runAtlas', 'writeEngram', 'renderAtlas'] }

describe('shredder cut: caller with callee', () => {
  it('folds an engram, a renderer and the command that calls both into one slice', () => {
    expect(foldCalleesIntoCallers([engram, renderer, command])).toEqual([['engram', 'renderer', 'command']])
  })

  it('folds a callee listed after its caller into the caller', () => {
    expect(foldCalleesIntoCallers([command, renderer])).toEqual([['command', 'renderer']])
  })

  it('folds a chain of callees with no caller of their own into the last caller', () => {
    const reader = { id: 'reader', defines: ['readEngram'], calls: [] }
    const writer = { id: 'writer', defines: ['writeEngram'], calls: ['readEngram'] }
    expect(foldCalleesIntoCallers([reader, writer, command])).toEqual([['reader', 'writer', 'command']])
  })

  it('keeps a slice that calls its own code apart from another slice that also calls it', () => {
    const wiredRenderer = { id: 'renderer', defines: ['renderAtlas', 'printAtlas'], calls: ['renderAtlas'] }
    expect(foldCalleesIntoCallers([wiredRenderer, command])).toEqual([['renderer'], ['command']])
  })

  it('keeps a slice that nothing calls on its own', () => {
    const lone = { id: 'lone', defines: ['orphan'], calls: [] }
    expect(foldCalleesIntoCallers([lone, command])).toEqual([['lone'], ['command']])
  })

  it('prints the folded cut with --cut for a cut shaped like Atlas', () => {
    const output = execFileSync('pnpm', ['exec', 'tsx', CLI, '--cut', ATLAS_CUT], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([['532-engram', '533-renderer', '534-atlas-command']])
  })
})
