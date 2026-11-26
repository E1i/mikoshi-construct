import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const THE_GATE = 'scripts/core/db.ts'
const OPENER_CALL = /\b(openOwnerWait|openBusWait)\(/g
const DEFINITION = /function\s+$/
const TESTS = /^(?:scripts\/tests|tests)\//

interface OpenerCall {
  file: string
  line: number
  args: string
}

function sources(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'scripts', 'src'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return listed.split('\n').filter(file => file.endsWith('.ts') && !TESTS.test(file) && file !== THE_GATE)
}

function argumentsAt(text: string, open: number): string {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    if (text[at] === '(')
      depth += 1
    if (text[at] === ')')
      depth -= 1
    if (depth === 0)
      return text.slice(open + 1, at)
  }
  return text.slice(open + 1)
}

function openerCalls(file: string, text: string): OpenerCall[] {
  return [...text.matchAll(OPENER_CALL)].flatMap((call) => {
    if (DEFINITION.test(text.slice(Math.max(0, call.index - 20), call.index)))
      return []
    const open = call.index + call[0].length - 1
    return [{ file, line: text.slice(0, call.index).split('\n').length, args: argumentsAt(text, open) }]
  })
}

function namesALift(call: OpenerCall, text: string): boolean {
  if (/\blift\b/.test(call.args))
    return true
  const last = /(\w+)\s*$/.exec(call.args.trim())?.[1]
  return last !== undefined && new RegExp(`const ${last}\\b[^\\n]*\\blift\\b`).test(text)
}

describe('the contract: every owner wait carries its lift condition as data', () => {
  it('every owner wait opener writes a lift condition', () => {
    const calls = sources().flatMap((file) => {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      return openerCalls(file, text).filter(call => !namesALift(call, text)).map(call => `${call.file}:${call.line}`)
    })
    expect(calls, 'an opener in scripts/ or src/ that writes owner.wait.opened with no lift').toEqual([])

    const openers = new Set(sources().filter(file => openerCalls(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')).length > 0))
    expect([...openers]).toEqual(expect.arrayContaining(['scripts/nodes/answer/answer-executor.ts', 'scripts/supervisor/dead-ends.ts', 'scripts/nodes/answer/duties/source.ts', 'scripts/nodes/update/update-executor.ts', 'scripts/window/requests/owner-wait.ts']))

    const writers = sources().filter(file => /type:\s*OWNER_WAIT_OPENED\b/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
    expect(writers, `owner.wait.opened is written only through the gate in ${THE_GATE}`).toEqual([])
  })
})
