import type { RunDecomposition, RunStep, UnreadAgent } from './steps.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const STEP_CACHE_FILE = '.construct/steps.jsonl'

const STEP_CACHE_VERSION = 1

export interface StepCache {
  runs: Map<string, RunStep[]>
  malformed: number[]
  unread: UnreadAgent[]
}

function isStep(value: unknown): value is RunStep {
  if (value == null || typeof value !== 'object')
    return false
  const step = value as Record<string, unknown>
  return typeof step.step === 'string'
    && typeof step.role === 'string'
    && typeof step.attempt === 'number'
    && (step.effort === null || typeof step.effort === 'string')
    && typeof step.tokens === 'number'
    && typeof step.seconds === 'number'
}

function cachedLine(text: string): { run: string, steps: RunStep[] } | null {
  try {
    const line = JSON.parse(text) as Record<string, unknown>
    if (line.v !== STEP_CACHE_VERSION || typeof line.run !== 'string' || line.run === '' || !Array.isArray(line.steps) || !line.steps.every(isStep))
      return null
    return { run: line.run, steps: line.steps }
  }
  catch {
    return null
  }
}

export function readStepCache(root: string): StepCache {
  const file = path.join(root, STEP_CACHE_FILE)
  const cache: StepCache = { runs: new Map(), malformed: [], unread: [] }
  if (!existsSync(file))
    return cache
  readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
    if (text.trim() === '')
      return
    const line = cachedLine(text)
    if (line == null)
      cache.malformed.push(index + 1)
    else if (!cache.runs.has(line.run))
      cache.runs.set(line.run, line.steps)
  })
  return cache
}

function stepRecord(step: RunStep): RunStep {
  return { step: step.step, role: step.role, attempt: step.attempt, effort: step.effort, tokens: step.tokens, seconds: step.seconds }
}

type Decompose = (run: string) => RunDecomposition | null

function missingRunSteps(cache: StepCache, runs: string[], decompose: Decompose): Array<[string, RunStep[]]> {
  const missing: Array<[string, RunStep[]]> = []
  for (const run of new Set(runs)) {
    if (cache.runs.has(run))
      continue
    const decomposition = decompose(run)
    if (decomposition == null)
      continue
    if (decomposition.unread.length > 0)
      cache.unread.push(...decomposition.unread)
    else
      missing.push([run, decomposition.steps])
  }
  return missing
}

function withRunSteps(cache: StepCache, missing: Array<[string, RunStep[]]>): StepCache {
  for (const [run, steps] of missing)
    cache.runs.set(run, steps)
  return cache
}

export function knownRunSteps(root: string, runs: string[], decompose: Decompose): StepCache {
  const cache = readStepCache(root)
  return withRunSteps(cache, missingRunSteps(cache, runs, decompose))
}

export function recordRunSteps(root: string, runs: string[], decompose: Decompose): StepCache {
  const cache = readStepCache(root)
  const missing = missingRunSteps(cache, runs, decompose)
  const lines = missing.map(([run, steps]) => JSON.stringify({ v: STEP_CACHE_VERSION, run, steps: steps.map(stepRecord) }))
  if (lines.length > 0) {
    const file = path.join(root, STEP_CACHE_FILE)
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${separator}${lines.join('\n')}\n`)
  }
  return withRunSteps(cache, missing)
}
