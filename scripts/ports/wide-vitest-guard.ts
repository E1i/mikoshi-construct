import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const MAX_TEST_DIRECTORIES = 3

export const WIDE_VITEST_RULE = 'Run by hand only the witness tests and the tests of the files you touched; prepush and CI run the rest. Never pass whole test directories to vitest by hand: name the test files.'

const GUARD_FILE = fileURLToPath(import.meta.url)

export const WIDE_VITEST_HOOKS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${GUARD_FILE}"`, timeout: 5 }] }],
} as const

const SEGMENT_SEPARATOR = /^[;&|\n]$/
const QUOTE = /^['"]$/
const REDIRECTION = /^\d*[<>]/
const REDIRECTION_WITHOUT_TARGET = /^\d*(?:<|>>?)$/
const TEST_SCRIPT = 'test'
const VITEST_WORD = /(?:^|\/)vitest$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?(?::\d+)?$/
const GLOB_CHARACTER = /[*?[{]/
const SUBCOMMANDS = new Set(['dev', 'related', 'watch', 'run'])
const OPTIONS_WITH_A_VALUE = new Set(['-t', '--testNamePattern', '-c', '--config', '--reporter', '-r', '--root', '--dir', '--project', '--shard', '--outputFile', '--pool', '--environment', '--exclude', '--mode', '--maxWorkers', '--minWorkers', '--testTimeout'])
const LAUNCHERS = new Set(['pnpm', 'npx', 'yarn', 'bunx', 'npm', 'exec', 'run', 'dlx', '--silent', '-s', '--'])
const LAUNCHER_OPTIONS_WITH_A_VALUE = new Set(['--dir', '-C', '--filter', '-F'])
const ENV_ASSIGNMENT = /^\w+=\S*$/
const ASKS_NO_RUN = new Set(['--version', '-v', '--help', '-h'])

export type VitestVerdict = { kind: 'allow' } | { kind: 'refuse', reason: string }

function segmentsOf(command: string): string[][] {
  const segments: string[][] = [[]]
  let word: string | null = null
  let quote: string | null = null
  const endWord = (): void => {
    if (word !== null)
      segments.at(-1)!.push(word)
    word = null
  }
  for (const char of command) {
    if (quote !== null) {
      if (char === quote)
        quote = null
      else
        word = (word ?? '') + char
    }
    else if (QUOTE.test(char)) {
      quote = char
      word = word ?? ''
    }
    else if (char === '&' && word !== null && word.endsWith('>')) {
      word += char
    }
    else if (SEGMENT_SEPARATOR.test(char)) {
      endWord()
      segments.push([])
    }
    else if (/\s/.test(char)) {
      endWord()
    }
    else {
      word = (word ?? '') + char
    }
  }
  endWord()
  return segments.filter(segment => segment.length > 0)
}

function onlyLaunchers(words: readonly string[]): boolean {
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!
    if (LAUNCHER_OPTIONS_WITH_A_VALUE.has(word))
      at++
    else if (!LAUNCHERS.has(word) && !ENV_ASSIGNMENT.test(word))
      return false
  }
  return true
}

function runsTheTestScript(words: readonly string[], at: number): boolean {
  return words[at] === TEST_SCRIPT && at > 0 && onlyLaunchers(words.slice(0, at))
}

function vitestArguments(words: readonly string[]): string[] | null {
  const at = words.findIndex((word, index) => VITEST_WORD.test(word) || runsTheTestScript(words, index))
  return at === -1 || !onlyLaunchers(words.slice(0, at)) ? null : words.slice(at + 1)
}

function positionalsOf(args: readonly string[]): string[] {
  const positionals: string[] = []
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (OPTIONS_WITH_A_VALUE.has(arg) || REDIRECTION_WITHOUT_TARGET.test(arg))
      at++
    else if (REDIRECTION.test(arg))
      continue
    else if (!arg.startsWith('-') && !(positionals.length === 0 && SUBCOMMANDS.has(arg)) && arg !== '')
      positionals.push(arg)
  }
  return positionals
}

function refusal(why: string): VitestVerdict {
  return { kind: 'refuse', reason: `refused by the wide-vitest guard: ${why}. ${WIDE_VITEST_RULE}` }
}

function segmentVerdict(args: readonly string[]): VitestVerdict {
  if (args.some(arg => ASKS_NO_RUN.has(arg)))
    return { kind: 'allow' }
  const positionals = positionalsOf(args)
  const glob = positionals.find(arg => GLOB_CHARACTER.test(arg))
  if (glob !== undefined)
    return refusal(`this vitest command names the glob ${glob}, which the shell expands to a whole directory`)
  const files = positionals.filter(arg => TEST_FILE.test(arg))
  const directories = positionals.length - files.length
  if (directories > MAX_TEST_DIRECTORIES)
    return refusal(`this vitest command names ${directories} test directories, more than ${MAX_TEST_DIRECTORIES}`)
  if (files.length === 0)
    return refusal('this vitest command names no test file')
  return { kind: 'allow' }
}

export function vitestVerdict(command: string): VitestVerdict {
  for (const segment of segmentsOf(command)) {
    const args = vitestArguments(segment)
    const verdict = args === null ? { kind: 'allow' as const } : segmentVerdict(args)
    if (verdict.kind === 'refuse')
      return verdict
  }
  return { kind: 'allow' }
}

function commandOf(hookInput: string): string | null {
  try {
    const input = JSON.parse(hookInput) as { tool_name?: unknown, tool_input?: { command?: unknown } } | null
    return input?.tool_name === 'Bash' && typeof input.tool_input?.command === 'string' ? input.tool_input.command : null
  }
  catch {
    return null
  }
}

export function hookAnswer(hookInput: string): string | null {
  const command = commandOf(hookInput)
  const verdict = command === null ? null : vitestVerdict(command)
  if (verdict === null || verdict.kind === 'allow')
    return null
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } })
}

function runsAsTheHook(): boolean {
  const invoked = process.argv[1]
  return invoked !== undefined && path.resolve(invoked) === GUARD_FILE
}

if (runsAsTheHook()) {
  const answer = hookAnswer(readFileSync(0, 'utf8'))
  if (answer !== null)
    process.stdout.write(`${answer}\n`)
}
