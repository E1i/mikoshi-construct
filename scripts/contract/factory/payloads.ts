import type { ParsedFile } from './walk.js'
import ts from 'typescript'
import { eachNode } from './walk.js'

export interface EventWrites {
  keys: string[]
  complete: boolean
}

export interface WrittenEvents {
  events: Record<string, EventWrites>
  outsideTheCatalogue: Record<string, EventWrites>
}

interface Keys {
  keys: string[]
  opaque: boolean
}

interface Tally {
  keys: Set<string>
  opaque: boolean
}

const NO_KEYS: Keys = { keys: [], opaque: true }
const NOT_EVENT_TYPES = new Set(['DEFERRED_TARGET', 'DROPPED_LANE', 'OPEN_PLAN', 'CLOSED_PLAN'])

function exportedStrings(source: ts.SourceFile): Map<string, string> {
  return new Map(source.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement))
      return []
    return statement.declarationList.declarations.flatMap((declaration) => {
      const value = declaration.initializer
      return ts.isIdentifier(declaration.name) && value !== undefined && ts.isStringLiteral(value) ? [[declaration.name.text, value.text] as const] : []
    })
  }))
}

export function catalogueOf(events: ParsedFile): Map<string, string> {
  return new Map([...exportedStrings(events.source)].filter(([name]) => !NOT_EVENT_TYPES.has(name)))
}

function typesOf(value: ts.Expression, names: ReadonlyMap<string, string>): string[] {
  if (ts.isIdentifier(value))
    return names.has(value.text) ? [names.get(value.text)!] : []
  if (ts.isStringLiteralLike(value))
    return [value.text]
  if (ts.isConditionalExpression(value))
    return [...typesOf(value.whenTrue, names), ...typesOf(value.whenFalse, names)]
  if (ts.isParenthesizedExpression(value))
    return typesOf(value.expression, names)
  return []
}

function declaredObject(name: string, from: ts.Node): ts.Expression | null {
  for (let scope: ts.Node | undefined = from; scope !== undefined; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope))
      continue
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement))
        continue
      const found = statement.declarationList.declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
      if (found?.initializer !== undefined)
        return found.initializer
    }
  }
  return null
}

function mergedKeys(parts: readonly Keys[]): Keys {
  return { keys: parts.flatMap(part => part.keys), opaque: parts.some(part => part.opaque) }
}

function keysOfMember(member: ts.ObjectLiteralElementLike): Keys {
  if (ts.isSpreadAssignment(member))
    return keysOf(member.expression)
  const name = member.name
  if (name === undefined || ts.isComputedPropertyName(name))
    return NO_KEYS
  return { keys: [ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : name.getText()], opaque: false }
}

function keysOf(value: ts.Expression): Keys {
  if (ts.isObjectLiteralExpression(value))
    return mergedKeys(value.properties.map(keysOfMember))
  if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value))
    return keysOf(value.expression)
  if (ts.isConditionalExpression(value))
    return mergedKeys([keysOf(value.whenTrue), keysOf(value.whenFalse)])
  if (ts.isIdentifier(value)) {
    const declared = declaredObject(value.text, value)
    return declared === null ? NO_KEYS : keysOf(declared)
  }
  if (ts.isCallExpression(value) && value.expression.getText() === 'JSON.stringify' && value.arguments[0] !== undefined)
    return keysOf(value.arguments[0])
  return NO_KEYS
}

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const member of object.properties) {
    if (member.name === undefined || !ts.isIdentifier(member.name) || member.name.text !== name)
      continue
    if (ts.isPropertyAssignment(member))
      return member.initializer
    if (ts.isShorthandPropertyAssignment(member))
      return member.name
  }
  return null
}

function recordWrite(tallies: Map<string, Tally>, type: string, keys: Keys): void {
  const tally = tallies.get(type) ?? { keys: new Set<string>(), opaque: false }
  keys.keys.forEach(key => tally.keys.add(key))
  tallies.set(type, { keys: tally.keys, opaque: tally.opaque || keys.opaque })
}

function namesVisibleIn(source: ts.SourceFile, catalogue: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...catalogue, ...exportedStrings(source)])
}

function writesOfObject(node: ts.ObjectLiteralExpression, names: ReadonlyMap<string, string>, tallies: Map<string, Tally>): void {
  const type = propertyValue(node, 'type')
  const payload = propertyValue(node, 'payload')
  if (type !== null && payload !== null)
    typesOf(type, names).forEach(each => recordWrite(tallies, each, keysOf(payload)))
}

function keysBuiltByHelper(call: ts.CallExpression): Keys | null {
  const callee = call.expression
  if (!ts.isIdentifier(callee))
    return null
  const helper = call.getSourceFile().statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === callee.text) as ts.FunctionDeclaration | undefined
  if (helper?.body === undefined)
    return null
  const built: Keys[] = []
  eachNode(helper.body, (node) => {
    const payload = ts.isObjectLiteralExpression(node) && propertyValue(node, 'type') !== null ? propertyValue(node, 'payload') : null
    if (payload !== null)
      built.push(keysOf(payload))
  })
  return built.length === 0 ? null : mergedKeys(built)
}

function writesOfCall(node: ts.CallExpression, names: ReadonlyMap<string, string>, values: ReadonlySet<string>, tallies: Map<string, Tally>): void {
  node.arguments.forEach((argument, at) => {
    const type = ts.isIdentifier(argument) || ts.isStringLiteralLike(argument) ? typesOf(argument, names).find(each => values.has(each)) : undefined
    const payload = node.arguments.slice(at + 1).find(ts.isObjectLiteralExpression)
    const built = type === undefined ? null : keysBuiltByHelper(node)
    if (type !== undefined && payload !== undefined)
      recordWrite(tallies, type, keysOf(payload))
    if (type !== undefined && built !== null)
      recordWrite(tallies, type, built)
  })
}

function reading(tally: Tally | undefined): EventWrites {
  return tally === undefined ? { keys: [], complete: false } : { keys: [...tally.keys].sort(), complete: !tally.opaque }
}

export function writtenEvents(files: readonly ParsedFile[], catalogue: ReadonlyMap<string, string>): WrittenEvents {
  const values = new Set(catalogue.values())
  const tallies = new Map<string, Tally>()
  for (const { source } of files) {
    const names = namesVisibleIn(source, catalogue)
    eachNode(source, (node) => {
      if (ts.isObjectLiteralExpression(node))
        writesOfObject(node, names, tallies)
      else if (ts.isCallExpression(node))
        writesOfCall(node, names, values, tallies)
    })
  }
  return {
    events: Object.fromEntries([...values].map(type => [type, reading(tallies.get(type))])),
    outsideTheCatalogue: Object.fromEntries([...tallies].filter(([type]) => !values.has(type)).map(([type, tally]) => [type, reading(tally)])),
  }
}
