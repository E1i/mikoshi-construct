import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const BOARD_READER = 'src/commands/board/bus.ts'
const BOARD_ROOT = 'src/commands/board/index.ts'
const OWNED = JSON.parse(readFileSync(path.join(ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const BUS_READING_MODULES = ['bus', 'card-record']
const BUS_READING_FILES = new Set(BUS_READING_MODULES.flatMap(module => OWNED[module] ?? []))
const FILE_OPENERS = ['node:fs', 'src/commands/cost/bus.ts']
const SQLITE = 'node:sqlite'
const PRODUCT_BUS_READER = 'src/commands/cost/bus.ts'
const PORT = 'BoardBus'
const READER = 'BusReader'

interface Imported {
  target: string
  typeOnly: boolean
}

function sourceOf(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
}

function importsOf(file: string): Imported[] {
  return sourceOf(file).statements.filter(ts.isImportDeclaration).map((declaration) => {
    const specifier = (declaration.moduleSpecifier as ts.StringLiteral).text
    const target = specifier.startsWith('.') ? path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts') : specifier
    return { target, typeOnly: declaration.importClause?.isTypeOnly === true }
  })
}

function readerParameterTypes(file: string): string[] {
  const alias = sourceOf(file).statements.filter(ts.isTypeAliasDeclaration).find(each => each.name.text === READER)
  return alias !== undefined && ts.isFunctionTypeNode(alias.type) ? alias.type.parameters.map(parameter => parameter.type?.getText() ?? '') : []
}

describe('the board reader takes the bus contract and opens no bus file', () => {
  it('the board reader imports no file of the bus or of the card record, which read the bus', () => {
    expect(importsOf(BOARD_READER).filter(each => BUS_READING_FILES.has(each.target))).toEqual([])
  })

  it('the board reader imports no file opener and no sqlite constructor', () => {
    const imports = importsOf(BOARD_READER)
    expect(imports.filter(each => FILE_OPENERS.includes(each.target))).toEqual([])
    expect(imports.filter(each => each.target === SQLITE && !each.typeOnly)).toEqual([])
  })

  it('a board reader is a function of the bus contract it is handed', () => {
    expect(readerParameterTypes(BOARD_READER)).toEqual([PORT])
  })

  it('the board command root composes the bus contract from the bus readings and opens the bus through the product reader alone', () => {
    const imports = importsOf(BOARD_ROOT)
    expect(imports.filter(each => BUS_READING_FILES.has(each.target)).length).toBeGreaterThan(0)
    expect(imports.some(each => each.target === PRODUCT_BUS_READER && !each.typeOnly)).toBe(true)
    expect(imports.filter(each => each.target === SQLITE && !each.typeOnly)).toEqual([])
  })
})
