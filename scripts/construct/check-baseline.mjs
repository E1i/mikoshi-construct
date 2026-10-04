import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const SEPARATOR = ' › '
const WHOLE_FILE = '<suite>'
const NO_RULE = '<no rule>'
const OUTPUT_LIMIT = 256 * 1024 * 1024
const PLAIN_OUTPUT = { NO_COLOR: '1', FORCE_COLOR: '0' }

const ESLINT_PROBLEM = /^\s+\d+:\d+ +error +(\S.*)$/
const ESLINT_COLUMNS = /\s{2,}/
const VITEST_TEST = /^\s*FAIL +(\S.*?) > (.+)$/
const VITEST_WHOLE_FILE = /^\s*FAIL\s+(\S+) \[ .+ \]$/
const JEST_FILE = /^\s*FAIL\s+(\S+)\s*$/
const JEST_TEST = /^\s{2,}● (.+)$/
const JEST_SUITE_FAILED = 'Test suite failed to run'
const JEST_CONSOLE = 'Console'
const JEST_SUMMARY = 'Summary of all failing tests'
const TSC_PLAIN = /^(\S.*?)\(\d+,\d+\): error (TS\d+): (.*)$/
const TSC_PRETTY = /^(\S.*?):\d+:\d+ - error (TS\d+): (.*)$/

function identity(...parts) {
  return parts.join(SEPARATOR)
}

export function eslintStylish(output, cwd) {
  const failures = []
  let file = null
  for (const line of output.split('\n')) {
    if (path.isAbsolute(line.trim()) && !line.startsWith(' ')) {
      file = path.relative(cwd, line.trim())
      continue
    }
    const problem = file === null ? null : ESLINT_PROBLEM.exec(line)
    if (problem === null)
      continue
    const columns = problem[1].trim().split(ESLINT_COLUMNS)
    failures.push(identity(file, columns.length > 1 ? columns.at(-1) : NO_RULE))
  }
  return failures
}

function numberRepeats(names) {
  const seen = new Map()
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count === 1 ? name : `${name} #${count}`
  })
}

export function vitestDefault(output) {
  const names = []
  for (const line of output.split('\n')) {
    const whole = VITEST_WHOLE_FILE.exec(line)
    const test = whole === null ? VITEST_TEST.exec(line) : null
    if (whole !== null)
      names.push(identity(whole[1], WHOLE_FILE))
    else if (test !== null)
      names.push(identity(test[1], ...test[2].split(' > ')))
  }
  return numberRepeats(names)
}

export function jestDefault(output) {
  const names = []
  let file = null
  for (const line of output.split('\n')) {
    if (line.trim() === JEST_SUMMARY)
      break
    const failed = JEST_FILE.exec(line)
    if (failed !== null) {
      file = failed[1]
      continue
    }
    const test = file === null ? null : JEST_TEST.exec(line)
    if (test === null || test[1] === JEST_CONSOLE)
      continue
    names.push(test[1] === JEST_SUITE_FAILED ? identity(file, WHOLE_FILE) : identity(file, test[1]))
  }
  return numberRepeats(names)
}

export function tsc(output) {
  return output.split('\n')
    .map(line => TSC_PLAIN.exec(line) ?? TSC_PRETTY.exec(line))
    .filter(found => found !== null)
    .map(([, file, code, message]) => identity(file, code, message.trim()))
}

export function failuresOf(exitCode, output, cwd) {
  if (exitCode === 0)
    return []
  const plain = stripVTControlCharacters(output)
  const found = [eslintStylish(plain, cwd), vitestDefault(plain), jestDefault(plain), tsc(plain)].flat()
  return found.length === 0 ? null : found.sort()
}

function runStep(step, cwd) {
  const result = spawnSync(step, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: OUTPUT_LIMIT,
    env: { ...process.env, ...PLAIN_OUTPUT },
  })
  const exitCode = result.status ?? 1
  return { step, exitCode, failures: failuresOf(exitCode, `${result.stdout ?? ''}\n${result.stderr ?? ''}`, cwd) }
}

export function canonicalSet(results) {
  if (results.some(result => result.failures === null))
    return null
  return results.flatMap(result => result.failures.map(failure => identity(result.step, failure))).sort()
}

export function setSha256(set) {
  return set === null ? null : crypto.createHash('sha256').update(set.join('\n')).digest('hex')
}

export function checkBaseline(steps, cwd) {
  const results = steps.map(step => runStep(step, cwd))
  const set = canonicalSet(results)
  return { steps: results, set, sha256: setSha256(set) }
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isEntry()) {
  const steps = process.argv.slice(2)
  if (steps.length === 0) {
    process.stderr.write('usage: node scripts/construct/check-baseline.mjs <step> [<step> …]\n')
    process.exitCode = 2
  }
  else {
    process.stdout.write(`${JSON.stringify(checkBaseline(steps, process.cwd()), null, 2)}\n`)
  }
}
