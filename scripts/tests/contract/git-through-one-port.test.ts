import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { SYNC_COMMANDS } from '../../ports/git.js'

const ROOT = process.cwd()
const NODE_DIRECTORIES = ['scripts/nodes/launch', 'scripts/nodes/answer', 'scripts/nodes/review', 'scripts/nodes/close']
const PORT_USERS = ['scripts/ports/card-tree.ts']
const PORT_MODULE = 'scripts/ports/git.ts'
const PORT_CALLS = ['syncThroughPort(', 'throughGitPort(']
const SYNC = SYNC_COMMANDS.join('|')
const SYNC_ARGS = new RegExp(String.raw`\[\s*'(?:${SYNC})'`)
const GIT_WITH_SYNC = new RegExp(String.raw`'git'.*'(?:${SYNC})'`)
const CALLEE = new RegExp(String.raw`([\w$.]+)\(\s*[^,()]+,\s*\[\s*'(?:${SYNC})'`)
const BOUND = /\b(?:export\s+)?const\s+(\w+)\s*=\s*throughGitPort\(/g
const NAMED_IMPORT = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g

function sourcesUnder(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => path.join(directory, file))
}

function boundIn(text: string): Set<string> {
  return new Set([...text.matchAll(BOUND)].map(match => match[1]!))
}

function importedBindings(file: string, text: string): Set<string> {
  const bound = new Set<string>()
  for (const [, names, from] of text.matchAll(NAMED_IMPORT)) {
    if (!from!.startsWith('.'))
      continue
    const module = path.relative(ROOT, path.resolve(ROOT, path.dirname(file), from!.replace(/\.js$/, '.ts')))
    let exported: Set<string>
    try {
      exported = module === PORT_MODULE ? new Set(['portGit']) : boundIn(readFileSync(path.join(ROOT, module), 'utf8'))
    }
    catch {
      continue
    }
    for (const name of names!.split(',').map(each => each.trim()).filter(each => each !== '')) {
      const [original, local] = name.split(/\s+as\s+/)
      if (exported.has(original!.trim()))
        bound.add((local ?? original!).trim())
    }
  }
  return bound
}

function callsOutsideThePort(file: string, text: string): string[] {
  const bound = new Set([...boundIn(text), ...importedBindings(file, text)])
  return text.split('\n').flatMap((line, index) => {
    const named = SYNC_ARGS.test(line) || GIT_WITH_SYNC.test(line)
    if (!named || PORT_CALLS.some(call => line.includes(call)))
      return []
    const callee = CALLEE.exec(line)?.[1]
    return callee !== undefined && !callee.includes('.') && bound.has(callee) ? [] : [`${file}:${index + 1}: ${line.trim()}`]
  })
}

describe('git through one port', () => {
  it('no node calls git fetch, commit or push outside the git port', () => {
    const files = [...NODE_DIRECTORIES.flatMap(sourcesUnder), ...PORT_USERS]
    expect(files.length).toBeGreaterThan(20)
    expect(files.flatMap(file => callsOutsideThePort(file, readFileSync(path.join(ROOT, file), 'utf8')))).toEqual([])
  })

  it('the reading names a bypass of the port', () => {
    const file = 'scripts/nodes/launch/bypass.ts'
    expect(callsOutsideThePort(file, 'processGit.read(tree, [\'push\', \'origin\'])')).toHaveLength(1)
    expect(callsOutsideThePort(file, 'function git(cwd, args) { return run(cwd, args) }\ngit(tree, [\'fetch\', \'origin\'])')).toHaveLength(1)
    expect(callsOutsideThePort(file, 'execFileSync(\'git\', [\'-C\', tree, \'commit\', \'-m\', message])')).toHaveLength(1)
    expect(callsOutsideThePort(file, 'const git = throughGitPort(run)\ngit(tree, [\'fetch\', \'origin\'])')).toEqual([])
  })
})
