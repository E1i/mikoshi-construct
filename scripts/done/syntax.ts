import path from 'node:path'
import ts from 'typescript'

export interface NamedFunction {
  name: string
  nameStart: number
  nameLine: number
  startLine: number
  endLine: number
  stubReason: string | undefined
}

const NOT_IMPLEMENTED = /not implemented|unimplemented|stub|todo/i

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
}

export function isParseable(file: string): boolean {
  return path.extname(file) in SCRIPT_KINDS && !file.endsWith('.d.ts')
}

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[path.extname(file)])
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function isFunctionValue(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

function withoutWrappers(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ? withoutWrappers(node.expression) : node
}

function isLiteral(expression: ts.Expression): boolean {
  const node = withoutWrappers(expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node))
    return true
  if (ts.isPrefixUnaryExpression(node))
    return (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(node.operand)
  if (ts.isArrayLiteralExpression(node))
    return node.elements.length === 0
  if (ts.isObjectLiteralExpression(node))
    return node.properties.length === 0
  if (ts.isIdentifier(node))
    return node.text === 'undefined'
  return node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name))
    return [name.text]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
}

function readsAny(body: ts.Node, names: string[]): boolean {
  let found = false
  walk(body, (node) => {
    if (ts.isIdentifier(node) && names.includes(node.text))
      found = true
  })
  return found
}

function onlyThrowsNotImplemented(statement: ts.Statement): boolean {
  if (!ts.isThrowStatement(statement) || !ts.isNewExpression(statement.expression))
    return false
  const first = statement.expression.arguments?.[0]
  return first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && NOT_IMPLEMENTED.test(first.text)
}

function stubReason(parameters: readonly ts.ParameterDeclaration[], body: ts.ConciseBody): string | undefined {
  if (ts.isBlock(body)) {
    if (body.statements.length === 0)
      return 'its body is empty'
    const [only] = body.statements
    if (body.statements.length === 1 && onlyThrowsNotImplemented(only!))
      return 'it only throws that it is not implemented'
  }
  const names = parameters.flatMap(parameter => bindingNames(parameter.name))
  if (parameters.length === 0 || readsAny(body, names))
    return undefined
  const returned = ts.isBlock(body)
    ? (body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!) ? (body.statements[0] as ts.ReturnStatement).expression ?? null : undefined)
    : body
  const literal = returned === null || (returned !== undefined && isLiteral(returned))
  return literal ? 'it returns a literal and never reads its parameters' : undefined
}

function describe(sourceFile: ts.SourceFile, name: ts.Identifier, fn: ts.FunctionLikeDeclaration, span: ts.Node): NamedFunction | undefined {
  if (fn.body === undefined)
    return undefined
  const line = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1
  return {
    name: name.text,
    nameStart: name.getStart(sourceFile),
    nameLine: line(name.getStart(sourceFile)),
    startLine: line(span.getStart(sourceFile)),
    endLine: line(span.getEnd()),
    stubReason: stubReason(fn.parameters, fn.body),
  }
}

export function namedFunctions(sourceFile: ts.SourceFile): NamedFunction[] {
  const found: NamedFunction[] = []
  walk(sourceFile, (node) => {
    let described: NamedFunction | undefined
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name))
      described = describe(sourceFile, node.name, node, node)
    else if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && ts.isIdentifier(node.name) && isFunctionValue(node.initializer))
      described = describe(sourceFile, node.name, node.initializer, node.initializer)
    if (described !== undefined)
      found.push(described)
  })
  return found
}

function isTestCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'it' || node.expression.text === 'test')
}

export function testTitles(sourceFile: ts.SourceFile): string[] {
  const titles: string[] = []
  walk(sourceFile, (node) => {
    const first = isTestCall(node) ? node.arguments[0] : undefined
    if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)))
      titles.push(first.text)
  })
  return titles
}

export function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = []
  walk(sourceFile, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier))
      specifiers.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0]
      const callsModule = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      if (callsModule && first !== undefined && ts.isStringLiteral(first))
        specifiers.push(first.text)
    }
  })
  return specifiers
}
