import type { WaitKind, WaitTerm } from '../../core/events.js'
import type { Contract } from '../../intake/card-contract.js'
import type { ParsedFile } from './walk.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { CARD_VERSION, CARD_VERSION_KEY } from '../../core/bus-version.js'
import { CARD_ADMITTED, CARD_WAITS } from '../../core/events.js'
import { CONTRACT_FIELDS } from '../../intake/card-contract.js'
import { parsedFiles } from './walk.js'

export interface CardSection {
  cardVersion: number
  versionRecord: string
  fields: Record<string, string>
  contracts: Record<Contract, readonly string[]>
  waits: Record<WaitKind, WaitTerm>
}

const CARD_CONTRACT_MODULE = 'scripts/intake/card-contract.ts'
const FIELDS_INTERFACE = 'CardFields'
const DRAFT_MODULE = 'src/commands/intake/draft.ts'
const DRAFT_INTERFACES: Record<string, string> = { DraftCard: 'draft.', DraftPlan: 'draft.plan.' }

export const CARD_GRAMMAR_TREES = ['src/card', 'src/commands/intake', 'scripts/policy/touch-scope.ts']
const GRAMMAR_FILE = /\.ts$/
export const BODY_LABEL = /^[A-Z]?[a-z]+(?:,? [a-z]+)*: ?$/
export const LABEL_CONSTANT = /_(?:PREFIX|HEADER|HEADING|FIELD)$/
const LABELLED_LINE = /^\^\(?([a-z|]+)\)?:/
export const NOT_A_BODY_FIELD: Record<string, string> = { 'exit:': 'a verdict a witness head or base holds, read inside the witnesses field' }
const BODY_LINE_READ_BY = 'body line read by'

function interfaceFields(source: ts.SourceFile, name: string, module: string): Record<string, string> {
  const declared = source.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name)
  if (declared === undefined)
    throw new Error(`${module} declares no ${name}, so the card section has no fields to read`)
  return Object.fromEntries(declared.members
    .filter(ts.isPropertySignature)
    .map(member => [member.name.getText(source), member.type === undefined ? 'unknown' : member.type.getText(source).replace(/\s+/g, ' ')]))
}

function labelsOf(declaration: ts.VariableDeclaration): string[] {
  const value = declaration.initializer
  if (!ts.isIdentifier(declaration.name) || value === undefined)
    return []
  if (ts.isStringLiteral(value))
    return LABEL_CONSTANT.test(declaration.name.text) && BODY_LABEL.test(value.text) ? [value.text.trimEnd()] : []
  if (!ts.isRegularExpressionLiteral(value))
    return []
  const alternatives = LABELLED_LINE.exec(value.text.slice(1, value.text.lastIndexOf('/')))?.[1]
  return alternatives === undefined ? [] : alternatives.split('|').map(label => `${label}:`)
}

export function bodyLabels(files: readonly ParsedFile[]): Record<string, string> {
  const readers = new Map<string, Set<string>>()
  for (const { file, source } of files) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement))
        continue
      statement.declarationList.declarations.flatMap(labelsOf).filter(label => !Object.hasOwn(NOT_A_BODY_FIELD, label)).forEach((label) => {
        readers.set(label, (readers.get(label) ?? new Set<string>()).add(file))
      })
    }
  }
  return Object.fromEntries([...readers].map(([label, files]) => [label, `${BODY_LINE_READ_BY} ${[...files].sort().join(', ')}`]))
}

function scannedTreeOf(tree: string): string {
  return GRAMMAR_FILE.test(tree) ? path.posix.dirname(tree) : tree
}

function inCardGrammar(file: string): boolean {
  return CARD_GRAMMAR_TREES.some(tree => file === tree || file.startsWith(`${tree}/`))
}

export function cardGrammarFiles(root: string): ParsedFile[] {
  return parsedFiles(root, [...new Set(CARD_GRAMMAR_TREES.map(scannedTreeOf))]).filter(({ file }) => inCardGrammar(file))
}

function draftFields(root: string): Record<string, string> {
  const source = ts.createSourceFile(DRAFT_MODULE, readFileSync(path.join(root, DRAFT_MODULE), 'utf8'), ts.ScriptTarget.Latest, true)
  return Object.fromEntries(Object.entries(DRAFT_INTERFACES).flatMap(([name, prefix]) =>
    Object.entries(interfaceFields(source, name, DRAFT_MODULE)).map(([field, type]) => [`${prefix}${field}`, type])))
}

export const GENERATED_WAITS_FROM = 'export const WAIT_LIFTERS = '

export function cardWaitsCode(waits: Readonly<Record<string, WaitTerm>>): string {
  const lifters = [...new Set(Object.values(waits).map(term => term.lifter))]
  return [
    `${GENERATED_WAITS_FROM}[${lifters.map(lifter => `'${lifter}'`).join(', ')}] as const`,
    '',
    'export type WaitLifter = typeof WAIT_LIFTERS[number]',
    '',
    'export interface WaitTerm {',
    '  lifter: WaitLifter',
    '  deadlineMinutes: number',
    '}',
    '',
    'export const CARD_WAITS = {',
    ...Object.entries(waits).map(([kind, term]) => `  ${kind}: { lifter: '${term.lifter}', deadlineMinutes: ${term.deadlineMinutes} },`),
    '} as const satisfies Record<string, WaitTerm>',
    '',
    'export type WaitKind = keyof typeof CARD_WAITS',
    '',
  ].join('\n')
}

export function cardSection(root: string): CardSection {
  const source = ts.createSourceFile(CARD_CONTRACT_MODULE, readFileSync(path.join(root, CARD_CONTRACT_MODULE), 'utf8'), ts.ScriptTarget.Latest, true)
  const fields = { ...interfaceFields(source, FIELDS_INTERFACE, CARD_CONTRACT_MODULE), ...bodyLabels(cardGrammarFiles(root)), ...draftFields(root) }
  return { cardVersion: CARD_VERSION, versionRecord: `${CARD_ADMITTED} payload.${CARD_VERSION_KEY}`, fields, contracts: CONTRACT_FIELDS, waits: CARD_WAITS }
}
