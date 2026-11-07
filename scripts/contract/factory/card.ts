import type { Contract } from '../../intake/card-contract.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { CARD_VERSION, CARD_VERSION_LINE } from '../../core/bus-version.js'
import { CONTRACT_FIELDS } from '../../intake/card-contract.js'

export interface CardSection {
  cardVersion: number
  versionLine: string
  fields: Record<string, string>
  contracts: Record<Contract, readonly string[]>
}

const CARD_CONTRACT_MODULE = 'scripts/intake/card-contract.ts'
const FIELDS_INTERFACE = 'CardFields'

function fieldsOf(source: ts.SourceFile): Record<string, string> {
  const declared = source.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === FIELDS_INTERFACE)
  if (declared === undefined)
    throw new Error(`${CARD_CONTRACT_MODULE} declares no ${FIELDS_INTERFACE}, so the card section has no fields to read`)
  return Object.fromEntries(declared.members
    .filter(ts.isPropertySignature)
    .map(member => [member.name.getText(source), member.type === undefined ? 'unknown' : member.type.getText(source).replace(/\s+/g, ' ')]))
}

export function cardSection(root: string): CardSection {
  const source = ts.createSourceFile(CARD_CONTRACT_MODULE, readFileSync(path.join(root, CARD_CONTRACT_MODULE), 'utf8'), ts.ScriptTarget.Latest, true)
  return { cardVersion: CARD_VERSION, versionLine: CARD_VERSION_LINE, fields: fieldsOf(source), contracts: CONTRACT_FIELDS }
}
