import path from 'node:path'

export interface TestRunner {
  runs: (command: string) => boolean
  ranNoTests: (output: string) => boolean
  isTestFile: (file: string) => boolean
  retargeted: (run: string, files: readonly string[]) => string | null
}

export interface CardScope { touches: readonly string[], creates: readonly string[] }

const VITEST = /\bvitest\b/
const VITEST_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const VITEST_NO_TEST = /No test files found|matched no test/
const VITEST_INVOCATION = /^\S.*?\bvitest\b(?:\s+run\b)?/
const RUN_VERB = ' run'
const NEGATION = /^!\s+/
const TEST_NAME_ARGUMENT = /(?:^|\s)(?:-t|--testNamePattern)(?:=|\s+)(?:'[^']*'|"(?:[^"\\]|\\.)*"|\S+)/g
const OUTPUT_REDIRECT = /(?:\d|&)?>>?\s*\S+/g
const ARGUMENT_PREFIX = /^(?:[\w-]+=|\d*[<>]+&?|['"(])+/
const TRAILING_QUOTES = /['");]+$/
const HOME_REFERENCE = /^~(?:\/|$)|\$\{?HOME\b/
const NOT_A_PLAIN_PATH = /[:*?$`()|[\]+^\\'"]/
const PATTERN_FLAG = /^-[a-zA-Z]*[eEF]$/
const QUOTE_LED = /^(?:[\w-]+=)?(?:['"]\\?['"]|\\['"])/
const CURRENT_DIRECTORY = /^\.\//
const SCOPE_GLOB_TAIL = /\/\*\*$/
const TRAILING_SLASHES = /\/+$/

function unnegated(run: string): string {
  return run.trim().replace(NEGATION, '').trim()
}

const VITEST_RUNNER: TestRunner = {
  runs: command => VITEST.test(command),
  ranNoTests: output => VITEST_NO_TEST.test(output),
  isTestFile: file => VITEST_TEST_FILE.test(file),
  retargeted: (run, files) => {
    const invocation = VITEST_INVOCATION.exec(unnegated(run))?.[0]
    if (invocation === undefined)
      return null
    return [invocation.endsWith(RUN_VERB) ? invocation : `${invocation}${RUN_VERB}`, ...files].join(' ')
  },
}

const TEST_RUNNERS: readonly TestRunner[] = [VITEST_RUNNER]

export function testRunnerOf(command: string): TestRunner | null {
  return TEST_RUNNERS.find(runner => runner.runs(command)) ?? null
}

function isPlainRelativePath(token: string): boolean {
  return token.includes('/') && !token.startsWith('-') && !path.isAbsolute(token) && !HOME_REFERENCE.test(token) && !NOT_A_PLAIN_PATH.test(token)
}

function followsPatternFlag(index: number, tokens: readonly string[]): boolean {
  return index > 0 && PATTERN_FLAG.test(tokens[index - 1] ?? '')
}

export function namedPaths(run: string): string[] {
  const tokens = unnegated(run).replace(TEST_NAME_ARGUMENT, ' ').replace(OUTPUT_REDIRECT, ' ').split(/\s+/)
  const operands = tokens.filter((token, index) => !followsPatternFlag(index, tokens) && !QUOTE_LED.test(token))
  const named = operands.map(token => token.replace(ARGUMENT_PREFIX, '').replace(TRAILING_QUOTES, '')).filter(isPlainRelativePath)
  return [...new Set(named.map(token => token.replace(CURRENT_DIRECTORY, '').replace(TRAILING_SLASHES, '')))]
}

export function findsNoTest(run: string, absent: (file: string) => boolean): boolean {
  const named = namedPaths(run)
  const runner = testRunnerOf(run)
  return runner !== null && named.length > 0 && named.every(absent) && !named.some(runner.isTestFile)
}

export function withinScope(file: string, scope: readonly string[]): boolean {
  return scope.some((entry) => {
    const root = entry.replace(SCOPE_GLOB_TAIL, '').replace(TRAILING_SLASHES, '')
    return file === root || file.startsWith(`${root}/`) || root.startsWith(`${file}/`)
  })
}

export function namedAbsentOutside(run: string, scope: CardScope, absent: (file: string) => boolean, changed: readonly string[] = []): string[] {
  const card = [...scope.touches, ...scope.creates, ...changed]
  return namedPaths(run).filter(file => absent(file) && !withinScope(file, card))
}
