import type { ModuleDeclaration } from '../../core/declarations.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_OWNS } from '../../contract/factory/module-owns.js'
import { DRAWN, MODULE_GRAPH, moduleOwnershipProblems, moduleOwnsOf, renderModuleOwns, writeModuleOwns } from '../../contract/factory/modules.js'
import { ownerOf, sourceFiles } from '../../contract/module-graph/ownership.js'
import { ownershipOf, readDeclarations } from '../../core/declarations.js'
import { GENERATED_FILES, GENERATED_PATHS } from '../../core/generated-files.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const DECLARED = readDeclarations(REPO_ROOT).modules
const MOVED = 'scripts/cli/board-warnings.ts'
const STRAY = 'scripts/stray/'

function declarationOf(module: string): ModuleDeclaration {
  return DECLARED.find(declared => declared.module === module)!
}

function withDeclaration(changed: ModuleDeclaration): ModuleDeclaration[] {
  return [...DECLARED.filter(declared => declared.module !== changed.module), changed]
}

describe('the module ownership of the module graph is generated from declarations/modules', () => {
  it('a declaration change changes the generated module ownership', () => {
    const board = declarationOf('board')
    const quality = declarationOf('quality')
    const moved = [...withDeclaration({ ...board, paths: board.paths.filter(entry => entry !== MOVED) }).filter(declared => declared.module !== 'quality'), { ...quality, paths: [...quality.paths, MOVED] }]

    const { owns, problems } = moduleOwnsOf(moved)

    expect(problems).toEqual([])
    expect(owns.board).not.toContain(MOVED)
    expect(owns.quality).toContain(MOVED)
    expect(owns).not.toEqual(MODULE_OWNS)
    expect(renderModuleOwns(owns)).not.toBe(renderModuleOwns(MODULE_OWNS))
  })

  it('the generated file on the tree is what the declarations produce, and the graph takes its owns from it', () => {
    const generated = readFileSync(path.join(REPO_ROOT, GENERATED_FILES.moduleOwns.path), 'utf8')

    expect(GENERATED_PATHS).toContain(GENERATED_FILES.moduleOwns.path)
    expect(generated).toBe(renderModuleOwns(moduleOwnsOf(DECLARED).owns))
    expect(moduleOwnershipProblems(MODULE_OWNS, DECLARED)).toEqual([])
    expect(Object.keys(MODULE_GRAPH.modules)).toEqual(Object.keys(DRAWN))
    for (const [id, spec] of Object.entries(MODULE_GRAPH.modules))
      expect(spec.owns.filter(glob => !glob.startsWith('!'))).toEqual(MODULE_OWNS[id])
  })

  it('every source file the graph gives a module, the declarations give the same module', () => {
    const drift = sourceFiles(REPO_ROOT).flatMap((file) => {
      const held = ownerOf(MODULE_GRAPH, file).filter(holder => holder in MODULE_GRAPH.modules)
      const declared = ownershipOf(DECLARED, file).owner
      return held.length === 1 && held[0] !== declared ? [`${file}: graph ${held[0]}, declarations ${declared}`] : []
    })

    expect(drift).toEqual([])
  })

  it('a mismatch between the declarations and the generated ownership fails the check', () => {
    const handEdited = { ...MODULE_OWNS, board: [...MODULE_OWNS.board!, 'scripts/cli/extra.ts'] }
    const board = declarationOf('board')
    const stale = withDeclaration({ ...board, paths: board.paths.filter(entry => entry !== MOVED) })

    expect(moduleOwnershipProblems(handEdited, DECLARED)).toEqual([`${GENERATED_FILES.moduleOwns.path}: the owns of board differ from declarations/modules/board.json; run pnpm declarations:update`])
    expect(moduleOwnershipProblems(MODULE_OWNS, stale)).toEqual([`${GENERATED_FILES.moduleOwns.path}: the owns of board differ from declarations/modules/board.json; run pnpm declarations:update`])
  })

  it('a module present in only one of the declarations and the hand-edited graph fails the check', () => {
    const stray: ModuleDeclaration = { module: 'stray', layer: 'core', paths: [STRAY], exclude: [], shared: [] }
    const declaredOnly = [...DECLARED, stray]
    const { owns } = moduleOwnsOf(declaredOnly)
    const drawnOnly = { ...DRAWN, ghost: DRAWN.ui! }

    expect(moduleOwnershipProblems(owns, declaredOnly)).toEqual(['declarations/modules/stray.json gives stray source files, and the hand-drawn part of the module graph draws no stray'])
    expect(moduleOwnershipProblems(MODULE_OWNS, DECLARED, drawnOnly)).toEqual(['the hand-drawn part of the module graph draws ghost, and no declaration gives it a source file'])
  })

  it('a declared path outside the source trees, a composition root or an excluded folder gives the graph no owns', () => {
    const { owns } = moduleOwnsOf(DECLARED)

    expect(owns.docs).toBeUndefined()
    expect(owns['factory-tests']).toBeUndefined()
    expect(owns.project).not.toContain('src/cli.ts')
    expect(owns.quality).not.toContain('scripts/scratch/**')
  })

  it('a pattern or an exclude inside a source tree is a problem the graph cannot carry', () => {
    const ui = declarationOf('ui')

    expect(moduleOwnsOf(withDeclaration({ ...ui, paths: ['src/ui/*.ts'], exclude: ['src/ui/lore.ts'] })).problems).toEqual([
      'declarations/modules/ui.json: exclude entry "src/ui/lore.ts" lies in a source tree, and the module graph carves out only files another module names',
      'declarations/modules/ui.json: "src/ui/*.ts" is a pattern, and the module graph holds only files and whole folders',
    ])
  })

  it('the writer refuses declarations that carry a problem, names it and leaves the generated file as it was', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'module-owns-'))
    try {
      const ui = declarationOf('ui')
      const target = path.join(root, GENERATED_FILES.moduleOwns.path)
      const declare = (declaration: ModuleDeclaration): void => {
        mkdirSync(path.join(root, 'declarations/modules'), { recursive: true })
        writeFileSync(path.join(root, 'declarations/modules/ui.json'), `${JSON.stringify(declaration, null, 2)}\n`)
      }

      declare({ ...ui, paths: ['src/ui/*.ts'] })
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, 'before\n')

      expect(writeModuleOwns(root)).toEqual(['declarations/modules/ui.json: "src/ui/*.ts" is a pattern, and the module graph holds only files and whole folders'])
      expect(readFileSync(target, 'utf8')).toBe('before\n')

      declare({ ...ui, paths: ['src/ui/'], exclude: [], shared: [] })

      expect(writeModuleOwns(root)).toEqual([])
      expect(existsSync(target) && readFileSync(target, 'utf8')).toBe(renderModuleOwns({ ui: ['src/ui/**'] }))
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
