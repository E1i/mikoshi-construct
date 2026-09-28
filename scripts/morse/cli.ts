import { readFileSync } from 'node:fs'
import process from 'node:process'
import { runBacktest } from './backtest.js'
import { getChangedFiles, resolveRevision } from './diff.js'
import { appendJournalLine } from './journal.js'
import { classify } from './rules.js'

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function requireFlag(argv: string[], name: string): string {
  const value = flag(argv, name)
  if (value === undefined)
    throw new Error(`${name} is required`)
  return value
}

function runClassify(argv: string[]): void {
  const filesPath = requireFlag(argv, '--files')
  const files = JSON.parse(readFileSync(filesPath, 'utf8'))
  const prediction = classify(files)
  process.stdout.write(`${JSON.stringify(prediction)}\n`)
}

function runPredict(argv: string[]): void {
  const task = requireFlag(argv, '--task')
  const base = requireFlag(argv, '--base')
  const head = requireFlag(argv, '--head')
  const journal = requireFlag(argv, '--journal')
  const repo = flag(argv, '--repo') ?? process.cwd()

  const baseSha = resolveRevision(repo, base)
  const headSha = resolveRevision(repo, head)
  const files = getChangedFiles(repo, baseSha, headSha)
  const prediction = classify(files)

  const line = JSON.stringify({
    task,
    base: baseSha,
    head: headSha,
    verdict: prediction.verdict,
    rule: prediction.rule,
    why: prediction.why,
  })

  appendJournalLine(journal, line)
  process.stdout.write(`${line}\n`)
}

function runBacktestCommand(argv: string[]): void {
  const prsPath = requireFlag(argv, '--prs')
  const text = readFileSync(prsPath, 'utf8')
  const result = runBacktest(text)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)

  try {
    switch (command) {
      case 'classify':
        runClassify(rest)
        break
      case 'predict':
        runPredict(rest)
        break
      case 'backtest':
        runBacktestCommand(rest)
        break
      default:
        throw new Error(`unknown command: ${command ?? ''}`)
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

main()
