import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checkEvidence } from './evidence.js'
import { byPosition, checkedFunctions } from './functions.js'
import { readMap } from './map.js'
import { readBrief } from './requirements.js'
import { readTree } from './tree.js'
import { isSource, nameAppearsElsewhere, unreachedFiles } from './wiring.js'

export interface DoneInputs {
  args: string
  map: string
  base: string
}

export interface DoneResult {
  passed: boolean
  lines: string[]
}

const OPTIONS = ['--args', '--map', '--base']

function failure(sections: Array<[string, string[]]>): DoneResult {
  const lines = sections.filter(([, items]) => items.length > 0).flatMap(([heading, items]) => [heading, ...items.map(item => `  ${item}`)])
  return { passed: false, lines: ['FAIL', ...lines] }
}

export function doneCheck(root: string, inputs: DoneInputs): DoneResult {
  try {
    const brief = readBrief(inputs.args)
    const rows = readMap(inputs.map)
    const tree = readTree(root, inputs.base)
    const evidence = checkEvidence(tree, brief, rows)
    const checked = checkedFunctions(tree, evidence.citations)
    const label = (fn: { file: string, nameLine: number, name: string }): string => `${fn.file}:${fn.nameLine} ${fn.name}`
    const stubs = checked.flatMap(fn => fn.stubReason === undefined ? [] : [`${label(fn)}: ${fn.stubReason}`])
    const unwiredFunctions = checked
      .filter(fn => !nameAppearsElsewhere(tree, fn.file, fn.name, fn.nameStart))
      .map(fn => `${label(fn)}: nothing outside tests names it`)
    const held = [...checked.map(fn => fn.file), ...evidence.citations.map(citation => citation.file)]
      .filter(isSource)
    const unwiredFiles = unreachedFiles(tree, held).map(file => `${file}: no file outside tests imports or names it`)
    const unwired = [...unwiredFunctions, ...unwiredFiles]
    if (evidence.problems.length + stubs.length + unwired.length > 0)
      return failure([['requirements:', evidence.problems], ['stubs:', stubs], ['unwired:', unwired]])
    const cleared = checked.length === 0 ? [] : ['checked by name only:', ...[...checked].sort(byPosition).map(fn => `  ${label(fn)}`)]
    const textOnly = evidence.textOnly.length === 0 ? [] : ['text only:', ...evidence.textOnly.map(row => `  ${row.id}: ${row.code.join(', ')}`)]
    const verdict = evidence.textOnly.length === 0 ? 'PASS' : `PASS · text only ${evidence.textOnly.length}`
    return { passed: true, lines: [verdict, `${brief.requirements.length} requirements mapped, ${checked.length} functions checked, no stub, nothing unwired`, ...cleared, ...textOnly] }
  }
  catch (error) {
    return failure([['input:', [String((error as Error).message).split('\n')[0]!]]])
  }
}

function parseOptions(argv: string[]): DoneInputs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]!
    if (!OPTIONS.includes(option))
      throw new Error(`unknown option ${option}`)
    const value = argv[index + 1]
    if (value === undefined)
      throw new Error(`${option} needs a value`)
    values.set(option, value)
  }
  const missing = OPTIONS.find(option => !values.has(option))
  if (missing !== undefined)
    throw new Error(`${missing} is required`)
  return { args: path.resolve(values.get('--args')!), map: path.resolve(values.get('--map')!), base: values.get('--base')! }
}

function runFromCommandLine(argv: string[]): DoneResult {
  let inputs: DoneInputs
  try {
    inputs = parseOptions(argv)
  }
  catch (error) {
    return failure([['input:', [(error as Error).message]]])
  }
  return doneCheck(process.cwd(), inputs)
}

function main(): void {
  const result = runFromCommandLine(process.argv.slice(2))
  process.stdout.write(`${result.lines.join('\n')}\n`)
  process.exitCode = result.passed ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
