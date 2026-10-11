import { readFileSync } from 'node:fs'
import process from 'node:process'
import { runBacktest } from './backtest.js'
import { predict } from './predict.js'
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
  const { line } = predict({
    task: requireFlag(argv, '--task'),
    base: requireFlag(argv, '--base'),
    head: requireFlag(argv, '--head'),
    journal: requireFlag(argv, '--journal'),
    repo: flag(argv, '--repo') ?? process.cwd(),
  })
  process.stdout.write(`${JSON.stringify(line)}\n`)
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
