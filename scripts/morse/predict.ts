import type { ChangedFile, Prediction } from './rules.js'
import process from 'node:process'
import { getChangedFiles, gitTopLevel, resolveRevision } from './diff.js'
import { appendJournalLine, refuseJournalInside } from './journal.js'
import { classify } from './rules.js'

export interface PredictRequest {
  task: string
  base: string
  head: string
  journal: string
  repo: string
}

export interface PredictionLine extends Prediction {
  task: string
  base: string
  head: string
}

export interface Predicted {
  line: PredictionLine
  files: ChangedFile[]
}

export function predict(request: PredictRequest): Predicted {
  const { task, journal, repo } = request
  refuseJournalInside(journal, [repo, process.cwd()].map(gitTopLevel).filter(top => top !== null))
  const base = resolveRevision(repo, request.base)
  const head = resolveRevision(repo, request.head)
  const files = getChangedFiles(repo, base, head)
  const prediction = classify(files)
  const line: PredictionLine = { task, base, head, verdict: prediction.verdict, rule: prediction.rule, why: prediction.why }
  appendJournalLine(journal, JSON.stringify(line))
  return { line, files }
}
