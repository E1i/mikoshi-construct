import ts from 'typescript'

export type Detector = (node: ts.Node, file: string) => string | null

const SPAWNING_CALLEE = /^(?:exec|spawn|run|call)/

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression
  if (ts.isIdentifier(callee))
    return callee.text
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node))
    return node.text
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('${}')
  return null
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent
  return ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent)
}

export function programCall(programs: readonly string[]): Detector {
  return (node) => {
    if (!ts.isCallExpression(node))
      return null
    const callee = calleeName(node)
    const first = node.arguments[0]
    if (callee === null || !SPAWNING_CALLEE.test(callee) || first === undefined)
      return null
    const text = literalText(first)
    const program = text === null ? undefined : programs.find(each => text === each || text.startsWith(`${each} `))
    return program === undefined ? null : `${callee}('${program}')`
  }
}

export function pidProbe(): Detector {
  return (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText() !== 'process.kill')
      return null
    const signal = node.arguments[1]
    return signal !== undefined && ts.isNumericLiteral(signal) && signal.text === '0' ? 'a probe of a pid with signal 0' : null
  }
}

export function declaredFunction(name: RegExp): Detector {
  return (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name) && name.test(node.name.text))
      return `function ${node.name.text}`
    return null
  }
}

export function called(names: readonly string[]): Detector {
  return (node) => {
    if (!ts.isCallExpression(node))
      return null
    const callee = calleeName(node)
    return callee !== null && names.includes(callee) ? `call of ${callee}` : null
  }
}

export function readOfAFileNamed(reader: string, name: RegExp): Detector {
  return (node) => {
    if (!ts.isCallExpression(node) || calleeName(node) !== reader)
      return null
    const first = node.arguments[0]
    return first !== undefined && ts.isIdentifier(first) && name.test(first.text) ? `${reader}(${first.text})` : null
  }
}

export function calledOnARead(outer: string, inner: string): Detector {
  return (node) => {
    if (!ts.isCallExpression(node) || calleeName(node) !== outer)
      return null
    const first = node.arguments[0]
    return first !== undefined && ts.isCallExpression(first) && calleeName(first) === inner ? `${outer}(${inner}(…))` : null
  }
}

function isItsOwnDeclaration(node: ts.Identifier): boolean {
  const parent = node.parent
  return ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)
    || ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node)
}

export function referenced(name: string): Detector {
  return node => ts.isIdentifier(node) && node.text === name && !isItsOwnDeclaration(node) ? `reference to ${name}` : null
}

function topLevelValue(source: ts.SourceFile, name: string): ts.Expression | undefined {
  return source.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText(source) === name)
    ?.initializer
}

export function referencedRegex(name: string, pattern: RegExp): Detector {
  return (node) => {
    if (!ts.isIdentifier(node) || node.text !== name || isItsOwnDeclaration(node))
      return null
    const value = topLevelValue(node.getSourceFile(), name)
    return value !== undefined && ts.isRegularExpressionLiteral(value) && pattern.test(value.text) ? `reference to ${name}` : null
  }
}

export function outside(files: ReadonlySet<string>, detector: Detector): Detector {
  return (node, file) => files.has(file) ? null : detector(node, file)
}

export function literal(matches: (text: string) => boolean, form: string): Detector {
  return (node) => {
    const text = literalText(node)
    return text !== null && !isModuleSpecifier(node) && matches(text) ? form : null
  }
}

export function regexLiteral(pattern: RegExp, form: string): Detector {
  return node => ts.isRegularExpressionLiteral(node) && pattern.test(node.text) ? form : null
}

export function propertyRead(name: string): Detector {
  return node => ts.isPropertyAccessExpression(node) && node.name.text === name ? `read of .${name}` : null
}

export function copiedProperty(name: string): Detector {
  return (node) => {
    if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== name)
      return null
    const value = node.initializer
    return ts.isPropertyAccessExpression(value) && value.name.text === name ? `${name}: <x>.${name}` : null
  }
}

export function adjacentLiterals(first: string, second: (text: string) => boolean, form: string): Detector {
  return (node) => {
    if (!ts.isArrayLiteralExpression(node))
      return null
    const texts = node.elements.map(literalText)
    return texts.some((text, at) => text === first && texts[at + 1] != null && second(texts[at + 1]!)) ? form : null
  }
}

export function entriesOfTable(inFile: string, table: string, form: string): Detector {
  return (node, file) => {
    if (file !== inFile || !ts.isPropertyAssignment(node))
      return null
    const holder = node.parent.parent
    return ts.isVariableDeclaration(holder) && holder.name.getText() === table ? `${form} ${literalText(node.name) ?? node.name.getText()}` : null
  }
}

export function declaredIn(inFile: string, duty: string, names: readonly string[]): Detector {
  return (node, file) => {
    if (file !== inFile || !(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) || node.name === undefined || !ts.isIdentifier(node.name))
      return null
    return names.includes(node.name.text) ? `${duty}: ${node.name.text}` : null
  }
}
