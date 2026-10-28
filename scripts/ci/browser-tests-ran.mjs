import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DECLARATION = /\bit(?:\.for|\.each)?(?:<[^>]*>)?\(/g
const NOT_RUN = new Set(['skipped', 'pending', 'todo', 'disabled'])

export function declaredTests(source) {
  return (source.match(DECLARATION) ?? []).length
}

function countStates(assertions) {
  const states = { passed: 0, failed: 0, notRun: 0 }
  for (const { status } of assertions) {
    if (status === 'passed')
      states.passed += 1
    else if (NOT_RUN.has(status))
      states.notRun += 1
    else
      states.failed += 1
  }
  return states
}

export function problemsOf(report, expected) {
  if (report === undefined)
    return ['vitest wrote no report']
  return Object.entries(expected).flatMap(([file, floor]) => {
    const result = (report.testResults ?? []).find(found => path.resolve(found.name) === path.resolve(file))
    if (result === undefined)
      return [`${file}: not in the report`]
    const { passed, failed, notRun } = countStates(result.assertionResults ?? [])
    return [
      ...(notRun > 0 ? [`${file}: ${notRun} skipped or todo`] : []),
      ...(failed > 0 ? [`${file}: ${failed} failed`] : []),
      ...(passed < floor ? [`${file}: ${passed} passed, ${floor} expected`] : []),
    ]
  })
}

function readReport(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  catch {
    return undefined
  }
}

function main(files) {
  if (files.length === 0 || files.some(file => !existsSync(file))) {
    process.stderr.write(`browser-tests-ran: ${files.length === 0 ? 'no test file given' : 'a test file does not exist'}\n`)
    return 1
  }
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'browser-tests-ran-'))
  const reportFile = path.join(workspace, 'report.json')
  try {
    const ran = spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`, ...files], { stdio: 'inherit', env: { ...process.env, BROWSER_LAB: '1' } })
    const expected = Object.fromEntries(files.map(file => [file, declaredTests(readFileSync(file, 'utf8'))]))
    const problems = problemsOf(readReport(reportFile), expected)
    for (const problem of problems)
      process.stderr.write(`browser-tests-ran: ${problem}\n`)
    return ran.status === 0 && problems.length === 0 ? 0 : 1
  }
  finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)))
