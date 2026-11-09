import type { ParsedFile } from './walk.js'
import path from 'node:path'
import ts from 'typescript'
import { eachNode } from './walk.js'

export interface EventWrites {
  keys: string[]
  complete: boolean
}

export interface RefusedWrite {
  type: string
  key: string
  file: string
}

export interface WrittenEvents {
  events: Record<string, EventWrites>
  outsideTheCatalogue: Record<string, EventWrites>
  refused: RefusedWrite[]
  opaque: Record<string, string[]>
  unwritten: Record<string, string[]>
}

export interface Catalogue {
  names: Map<string, string>
  payloads: Map<string, string[]>
}

interface Keys {
  keys: string[]
  opaqueAt: string[]
}

interface Reading {
  checker: ts.TypeChecker | null
  bindings: ReadonlyMap<string, ts.Expression>
  envelope?: string
  declared: ReadonlyMap<string, readonly string[]>
  fileOf: (source: ts.SourceFile) => string
  typed: (source: ts.SourceFile) => boolean
}

interface Tally {
  keys: Map<string, Set<string>>
  opaqueAt: Set<string>
}

const THE_DECLARATION = 'EVENT_PAYLOADS'
const REFUSED_AT_WRITE_TIME = 'declaredPayload'

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

function declarationOf(source: ts.SourceFile): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement))
      continue
    const found = statement.declarationList.declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === THE_DECLARATION)
    let value: ts.Expression | undefined = found?.initializer
    while (value !== undefined && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)))
      value = value.expression
    if (value !== undefined && ts.isObjectLiteralExpression(value))
      return value
  }
  throw new Error(`${source.fileName} declares no ${THE_DECLARATION} object, so no event type has a payload`)
}

function declaredType(member: ts.ObjectLiteralElementLike, names: ReadonlyMap<string, string>): string {
  const name = member.name
  const type = name === undefined
    ? undefined
    : ts.isComputedPropertyName(name) ? typesOf(name.expression, names)[0] : ts.isStringLiteralLike(name) || ts.isIdentifier(name) ? name.text : undefined
  if (type === undefined)
    throw new Error(`${THE_DECLARATION} has a member whose event type is not a constant of the module: ${member.getText()}`)
  return type
}

function declaredKeys(member: ts.ObjectLiteralElementLike, type: string): string[] {
  if (!ts.isPropertyAssignment(member) || !ts.isArrayLiteralExpression(member.initializer) || !member.initializer.elements.every(ts.isStringLiteralLike))
    throw new Error(`${THE_DECLARATION}[${type}] is not a list of key literals`)
  return member.initializer.elements.map(element => (element as ts.StringLiteralLike).text)
}

export function catalogueOf(events: ParsedFile): Catalogue {
  const names = exportedStrings(events.source)
  const payloads = new Map(declarationOf(events.source).properties.map((member) => {
    const type = declaredType(member, names)
    return [type, declaredKeys(member, type)] as const
  }))
  return { names, payloads }
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
  return { keys: parts.flatMap(part => part.keys), opaqueAt: parts.flatMap(part => part.opaqueAt) }
}

function opaque(value: ts.Node, reading: Reading): Keys {
  const source = value.getSourceFile()
  return { keys: [], opaqueAt: [`${reading.fileOf(source)}:${source.getLineAndCharacterOfPosition(value.getStart()).line + 1}`] }
}

const OPEN_TYPES = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive | ts.TypeFlags.TypeParameter | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess
const ABSENT_TYPES = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never

function keysOfType(type: ts.Type, checker: ts.TypeChecker): string[] | null {
  const keys: string[] = []
  for (const part of type.isUnion() ? type.types : [type]) {
    if ((part.flags & ABSENT_TYPES) !== 0)
      continue
    const apparent = (part.flags & OPEN_TYPES) !== 0 ? null : part
    if (apparent === null || ((apparent.flags & ts.TypeFlags.Object) === 0 && !apparent.isIntersection()) || checker.getIndexInfosOfType(apparent).some(index => (index.type.flags & ts.TypeFlags.Never) === 0))
      return null
    keys.push(...checker.getPropertiesOfType(apparent).map(property => property.name))
  }
  return keys
}

function typedKeys(value: ts.Expression, reading: Reading): Keys {
  const keys = reading.checker === null || !reading.typed(value.getSourceFile()) ? null : keysOfType(reading.checker.getTypeAtLocation(value), reading.checker)
  return keys === null ? opaque(value, reading) : { keys, opaqueAt: [] }
}

function literalOf(expression: ts.Expression, reading: Reading): string | null {
  if (reading.checker === null || !reading.typed(expression.getSourceFile()))
    return null
  const type = reading.checker.getTypeAtLocation(expression)
  return type.isStringLiteral() ? type.value : null
}

function computedKey(expression: ts.Expression, reading: Reading): Keys | null {
  const value = ts.isIdentifier(expression) ? declaredObject(expression.text, expression) : expression
  const key = value !== null && ts.isStringLiteralLike(value) ? value.text : literalOf(expression, reading)
  return key === null ? null : { keys: [key], opaqueAt: [] }
}

function reSpreadsItsOwnPayload(spread: ts.Expression, reading: Reading): boolean {
  return reading.envelope !== undefined && ts.isPropertyAccessExpression(spread) && spread.name.text === 'payload' && ts.isIdentifier(spread.expression) && spread.expression.text === reading.envelope
}

function keysOfMember(member: ts.ObjectLiteralElementLike, reading: Reading): Keys {
  if (ts.isSpreadAssignment(member))
    return reSpreadsItsOwnPayload(member.expression, reading) ? { keys: [], opaqueAt: [] } : keysOf(member.expression, reading)
  const name = member.name
  if (name !== undefined && ts.isComputedPropertyName(name))
    return computedKey(name.expression, reading) ?? opaque(member, reading)
  if (name === undefined)
    return opaque(member, reading)
  return { keys: [ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : name.getText()], opaqueAt: [] }
}

function keysOf(value: ts.Expression, reading: Reading): Keys {
  if (ts.isObjectLiteralExpression(value))
    return mergedKeys(value.properties.map(member => keysOfMember(member, reading)))
  if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value))
    return keysOf(value.expression, reading)
  if (ts.isConditionalExpression(value))
    return mergedKeys([keysOf(value.whenTrue, reading), keysOf(value.whenFalse, reading)])
  if (ts.isIdentifier(value)) {
    const bound = reading.bindings.get(value.text)
    if (bound !== undefined)
      return keysOf(bound, { ...reading, bindings: new Map() })
    const declared = declaredObject(value.text, value)
    return declared === null ? typedKeys(value, reading) : keysOf(declared, reading)
  }
  if (ts.isCallExpression(value) && value.expression.getText() === 'JSON.stringify' && value.arguments[0] !== undefined)
    return keysOf(value.arguments[0], reading)
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === REFUSED_AT_WRITE_TIME && value.arguments[1] !== undefined) {
    const checked = keysOf(value.arguments[1], reading)
    return checked.opaqueAt.length > 0 && reading.bindings.size === 0 ? typedKeys(value, reading) : { keys: checked.keys, opaqueAt: [] }
  }
  return typedKeys(value, reading)
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

function recordWrite(tallies: Map<string, Tally>, type: string, keys: Keys, file: string): void {
  const tally = tallies.get(type) ?? { keys: new Map<string, Set<string>>(), opaqueAt: new Set<string>() }
  keys.keys.forEach(key => tally.keys.set(key, (tally.keys.get(key) ?? new Set<string>()).add(file)))
  keys.opaqueAt.forEach(site => tally.opaqueAt.add(site))
  tallies.set(type, tally)
}

function namesVisibleIn(source: ts.SourceFile, names: ReadonlyMap<string, string>): Map<string, string> {
  return new Map([...names, ...exportedStrings(source)])
}

function spreadEnvelope(node: ts.ObjectLiteralExpression): string | undefined {
  const spread = node.properties.find(member => ts.isSpreadAssignment(member) && ts.isIdentifier(member.expression)) as ts.SpreadAssignment | undefined
  return spread === undefined ? undefined : (spread.expression as ts.Identifier).text
}

function typesSpreadInto(node: ts.ObjectLiteralExpression, reading: Reading): string[] {
  if (reading.checker === null || !reading.typed(node.getSourceFile()))
    return []
  const property = reading.checker.getTypeAtLocation(node).getProperty('type')
  if (property === undefined)
    return []
  const type = reading.checker.getTypeOfSymbolAtLocation(property, node)
  return (type.isUnion() ? type.types : [type]).flatMap(each => each.isStringLiteral() ? [each.value] : [])
}

function writesOfObject(node: ts.ObjectLiteralExpression, names: ReadonlyMap<string, string>, tallies: Map<string, Tally>, reading: Reading): void {
  const type = propertyValue(node, 'type')
  const payload = propertyValue(node, 'payload')
  if (payload === null)
    return
  const envelope = spreadEnvelope(node)
  const file = reading.fileOf(node.getSourceFile())
  const keys = keysOf(payload, { ...reading, envelope })
  if (type !== null) {
    typesOf(type, names).forEach(each => recordWrite(tallies, each, keys, file))
    return
  }
  const union = envelope === undefined ? [] : typesSpreadInto(node, reading)
  const declaredBy = (each: string, key: string): boolean => reading.declared.get(each)?.includes(key) === true
  union.forEach((each) => {
    const own = keys.keys.filter(key => declaredBy(each, key) || !union.some(other => declaredBy(other, key)))
    if (own.length > 0 || keys.opaqueAt.length > 0)
      recordWrite(tallies, each, { keys: own, opaqueAt: keys.opaqueAt }, file)
  })
}

function argumentBindings(helper: ts.FunctionDeclaration, call: ts.CallExpression): Map<string, ts.Expression> {
  return new Map(helper.parameters.flatMap((parameter, at) => {
    const bound = call.arguments[at] ?? parameter.initializer
    return ts.isIdentifier(parameter.name) && bound !== undefined ? [[parameter.name.text, bound] as const] : []
  }))
}

function helperOf(call: ts.CallExpression, reading: Reading): ts.FunctionDeclaration | undefined {
  const callee = call.expression
  if (!ts.isIdentifier(callee))
    return undefined
  const local = call.getSourceFile().statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === callee.text) as ts.FunctionDeclaration | undefined
  if (local !== undefined || reading.checker === null || !reading.typed(call.getSourceFile()))
    return local
  const symbol = reading.checker.getSymbolAtLocation(callee)
  const target = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? reading.checker.getAliasedSymbol(symbol) : symbol
  return target?.declarations?.find(ts.isFunctionDeclaration)
}

function writesOfAHelper(call: ts.CallExpression, catalogue: Catalogue, reading: Reading): [string, Keys][] {
  const helper = helperOf(call, reading)
  if (helper?.body === undefined || helper.getSourceFile() === call.getSourceFile())
    return []
  const names = namesVisibleIn(helper.getSourceFile(), catalogue.names)
  const inside = { ...reading, bindings: argumentBindings(helper, call) }
  const writes: [string, Keys][] = []
  eachNode(helper.body, (node) => {
    const type = ts.isObjectLiteralExpression(node) ? propertyValue(node, 'type') : null
    const payload = ts.isObjectLiteralExpression(node) ? propertyValue(node, 'payload') : null
    if (type === null || payload === null || !mentionsAny(payload, inside.bindings))
      return
    typesOf(type, names).filter(each => catalogue.payloads.has(each)).forEach(each => writes.push([each, keysOf(payload, { ...inside, envelope: spreadEnvelope(node as ts.ObjectLiteralExpression) })]))
  })
  return writes
}

function mentionsAny(node: ts.Node, bindings: ReadonlyMap<string, ts.Expression>): boolean {
  let found = false
  eachNode(node, (each) => {
    found ||= ts.isIdentifier(each) && bindings.has(each.text)
  })
  return found
}

function keysBuiltByHelper(call: ts.CallExpression, reading: Reading): Keys | null {
  const helper = helperOf(call, reading)
  if (helper?.body === undefined || helper.getSourceFile() !== call.getSourceFile())
    return null
  const inside = { ...reading, bindings: argumentBindings(helper, call) }
  const built: Keys[] = []
  eachNode(helper.body, (node) => {
    const payload = ts.isObjectLiteralExpression(node) && propertyValue(node, 'type') !== null ? propertyValue(node, 'payload') : null
    if (payload !== null)
      built.push(keysOf(payload, { ...inside, envelope: spreadEnvelope(node as ts.ObjectLiteralExpression) }))
  })
  return built.length === 0 ? null : mergedKeys(built)
}

function writesOfCall(node: ts.CallExpression, names: ReadonlyMap<string, string>, catalogue: Catalogue, tallies: Map<string, Tally>, reading: Reading): void {
  const values = new Set(catalogue.payloads.keys())
  const file = reading.fileOf(node.getSourceFile())
  writesOfAHelper(node, catalogue, reading).forEach(([type, keys]) => recordWrite(tallies, type, keys, file))
  node.arguments.forEach((argument, at) => {
    const type = ts.isIdentifier(argument) || ts.isStringLiteralLike(argument) ? typesOf(argument, names).find(each => values.has(each)) : undefined
    if (type === undefined)
      return
    const built = keysBuiltByHelper(node, reading)
    const payload = node.arguments.slice(at + 1).find(ts.isObjectLiteralExpression)
    const enveloped = payload === undefined ? null : propertyValue(payload, 'payload')
    if (built !== null)
      recordWrite(tallies, type, built, file)
    else if (payload !== undefined)
      recordWrite(tallies, type, keysOf(enveloped ?? payload, reading), file)
  })
}

function writesOf(tally: Tally): EventWrites {
  return { keys: [...tally.keys.keys()].sort(), complete: tally.opaqueAt.size === 0 }
}

function refusedOf(tallies: ReadonlyMap<string, Tally>, payloads: ReadonlyMap<string, readonly string[]>): RefusedWrite[] {
  return [...tallies].flatMap(([type, tally]) => {
    const declared = payloads.get(type)
    if (declared === undefined)
      return []
    return [...tally.keys].filter(([key]) => !declared.includes(key)).flatMap(([key, files]) => [...files].sort().map(file => ({ type, key, file })))
  })
}

export function typedReading(root: string, files: readonly ParsedFile[]): { files: ParsedFile[], checker: ts.TypeChecker } {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
  const program = ts.createProgram(files.map(({ file }) => path.join(root, file)), { ...config?.options, noEmit: true })
  return {
    files: files.map(({ file, source }) => ({ file, source: program.getSourceFile(path.join(root, file)) ?? source })),
    checker: program.getTypeChecker(),
  }
}

export function writtenEvents(files: readonly ParsedFile[], catalogue: Catalogue, checker: ts.TypeChecker | null = null): WrittenEvents {
  const values = new Set(catalogue.payloads.keys())
  const tallies = new Map<string, Tally>()
  const fileNames = new Map(files.map(({ file, source }) => [source, file] as const))
  const typed = new Set(files.filter(({ source }) => path.isAbsolute(source.fileName)).map(({ source }) => source))
  const reading: Reading = { checker, bindings: new Map(), declared: catalogue.payloads, fileOf: source => fileNames.get(source) ?? source.fileName, typed: source => typed.has(source) }
  for (const { source } of files) {
    const names = namesVisibleIn(source, catalogue.names)
    eachNode(source, (node) => {
      if (ts.isObjectLiteralExpression(node))
        writesOfObject(node, names, tallies, reading)
      else if (ts.isCallExpression(node))
        writesOfCall(node, names, catalogue, tallies, reading)
    })
  }
  return {
    events: Object.fromEntries([...catalogue.payloads].map(([type, keys]) => [type, { keys: [...keys].sort(), complete: (tallies.get(type)?.opaqueAt.size ?? 0) === 0 }])),
    outsideTheCatalogue: Object.fromEntries([...tallies].filter(([type]) => !values.has(type)).map(([type, tally]) => [type, writesOf(tally)])),
    refused: refusedOf(tallies, catalogue.payloads),
    unwritten: Object.fromEntries([...catalogue.payloads].flatMap(([type, keys]) => {
      const written = tallies.get(type)?.keys
      const missing = written === undefined ? [] : keys.filter(key => !written.has(key))
      return missing.length === 0 ? [] : [[type, missing] as const]
    })),
    opaque: Object.fromEntries([...tallies].filter(([type, tally]) => values.has(type) && tally.opaqueAt.size > 0).map(([type, tally]) => [type, [...tally.opaqueAt].sort()])),
  }
}
