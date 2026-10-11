import type { EntryCommand } from './command.js'

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/
const KEY = /^( *)(- +)?([\w-]+):(.*)$/
const BLOCK_SCALAR = /^[|>][-+]?\d*\s*(?:#.*)?$/
const ROOT = '.'

export function declaresSteps(file: string): boolean {
  return WORKFLOW.test(file)
}

interface Step {
  job: string
  index: number
  name: string | null
  indent: number
  runs: Array<{ command: string, line: number }>
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length
}

function unquoted(value: string): string {
  const trimmed = value.trim()
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

function blockLines(lines: string[], start: number, keyIndent: number): Array<{ command: string, line: number }> {
  const found: Array<{ command: string, line: number }> = []
  for (let index = start; index < lines.length; index += 1) {
    const text = lines[index]
    if (text.trim() === '')
      continue
    if (indentOf(text) <= keyIndent)
      break
    found.push({ command: text.trim(), line: index + 1 })
  }
  return found
}

export function workflowSteps(_file: string, text: string): EntryCommand[] {
  const lines = text.split('\n')
  const steps: Step[] = []
  let inJobs = false
  let jobIndent = -1
  let job: string | null = null
  let step: Step | null = null
  let jobKeyIndent = -1
  let stepsIndent = -1
  let itemIndent = -1
  const enterJob = (name: string | null): void => {
    job = name
    step = null
    jobKeyIndent = -1
    stepsIndent = -1
    itemIndent = -1
  }
  lines.forEach((line, index) => {
    const match = KEY.exec(line)
    if (match == null)
      return
    const [, spaces, dash, key, rest] = match
    const value = rest.trim()
    const indent = spaces.length
    if (indent === 0 && dash === undefined) {
      inJobs = key === 'jobs'
      jobIndent = -1
      enterJob(null)
      return
    }
    if (!inJobs)
      return
    if (dash === undefined && (jobIndent === -1 || indent === jobIndent) && value === '') {
      jobIndent = indent
      enterJob(key)
      return
    }
    if (job == null)
      return
    if (jobKeyIndent === -1)
      jobKeyIndent = indent
    if (dash === undefined && indent <= stepsIndent) {
      stepsIndent = -1
      itemIndent = -1
      step = null
    }
    if (dash === undefined && indent === jobKeyIndent && key === 'steps' && value === '') {
      stepsIndent = indent
      return
    }
    if (stepsIndent === -1)
      return
    if (dash !== undefined && itemIndent === -1 && indent >= stepsIndent)
      itemIndent = indent
    if (dash !== undefined && indent === itemIndent) {
      step = { job, index: steps.filter(entry => entry.job === job).length + 1, name: null, indent: indent + dash.length, runs: [] }
      steps.push(step)
    }
    if (step == null || indent + (dash?.length ?? 0) !== step.indent)
      return
    if (key === 'name')
      step.name = unquoted(value)
    if (key === 'run')
      step.runs.push(...BLOCK_SCALAR.test(value) ? blockLines(lines, index + 1, step.indent) : [{ command: unquoted(value), line: index + 1 }])
  })
  return steps.flatMap(entry => entry.runs.map(run => ({ name: `${entry.job} › ${entry.name ?? `step ${entry.index}`}`, command: run.command, line: run.line, cwd: ROOT })))
}
