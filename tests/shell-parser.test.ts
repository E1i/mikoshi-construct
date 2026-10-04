import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

interface Word { text: string }
interface Visited { words: Word[], index: number, directory: string | null }
interface Git { subcommand: string, words: Word[], target: string | null, gitDir: string | null, pinned: boolean }
interface Parser {
  scanCommand: (text: string) => unknown[]
  walkCommands: (tokens: unknown[], start: string, visit: (visited: Visited) => string[] | null) => string[] | null
  gitInvocation: (visited: Visited) => Git | null
}

const PARSER_FILE = path.join(import.meta.dirname, '../templates/attach/_construct/shell-parser.mjs')
const { gitInvocation, scanCommand, walkCommands } = await import(PARSER_FILE) as Parser

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-shell-parser-')))
mkdirSync(path.join(root, 'sub'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Seen {
  program: string
  rest: string[]
  directory: string | null
  git: Git | null
}

function seen(command: string, from = root): Seen[] {
  const found: Seen[] = []
  walkCommands(scanCommand(command), from, (visited) => {
    found.push({
      program: visited.words[visited.index]!.text,
      rest: visited.words.slice(visited.index + 1).map(word => word.text),
      directory: visited.directory,
      git: gitInvocation(visited),
    })
    return null
  })
  return found
}

describe('the shell parser hands every simple command to the visitor', () => {
  it('visits each command of a list, in order', () => {
    expect(seen('echo one && ls -la; pwd').map(found => found.program)).toEqual(['echo', 'ls', 'pwd'])
  })

  it('visits a command inside $( ) and inside backticks before the command that holds it', () => {
    expect(seen('echo $(whoami) `date`').map(found => found.program)).toEqual(['whoami', 'date', 'echo'])
  })

  it('does not visit a heredoc body, a comment or a quoted word as a command', () => {
    expect(seen('cat <<EOF\ngit commit\nEOF\n# git push\necho "git tag"').map(found => found.program)).toEqual(['cat', 'echo'])
  })

  it('reads through a wrapper, an assignment and a reserved word to the program', () => {
    expect(seen('FOO=1 env -u X nice -n 5 sudo -u me timeout 3 git status').map(found => found.program)).toEqual(['git'])
  })

  it('returns the first value the visitor returns and stops there', () => {
    const calls: string[] = []
    const result = walkCommands(scanCommand('a; b; c'), root, (visited) => {
      calls.push(visited.words[visited.index]!.text)
      return visited.words[visited.index]!.text === 'b' ? ['stop'] : null
    })
    expect(result).toEqual(['stop'])
    expect(calls).toEqual(['a', 'b'])
  })
})

describe('the shell parser tracks the directory a command runs in', () => {
  it('follows cd into an existing directory and an absolute one', () => {
    expect(seen('cd sub && git status').at(-1)?.directory).toBe(path.join(root, 'sub'))
  })

  it('loses the directory when cd names one that does not exist, comes from cd - or is piped', () => {
    expect(seen('cd nowhere && git status').at(-1)?.directory).toBeNull()
    expect(seen('cd - && git status').at(-1)?.directory).toBeNull()
    expect(seen('cd sub | cat; git status').at(-1)?.directory).toBeNull()
  })

  it('restores the directory when a subshell closes', () => {
    expect(seen('(cd sub && ls); git status').at(-1)?.directory).toBe(root)
  })

  it('loses the directory when a wrapper option moves it', () => {
    expect(seen('env -C /tmp git status').at(-1)?.directory).toBeNull()
  })
})

describe('the shell parser reads a git invocation', () => {
  it('names the subcommand and its words after the global options', () => {
    const git = seen('git -c a=b -C sub checkout -- file').at(-1)?.git
    expect(git?.subcommand).toBe('checkout')
    expect(git?.words.map(word => word.text)).toEqual(['checkout', '--', 'file'])
    expect(git?.target).toBe(path.join(root, 'sub'))
    expect(git?.pinned).toBe(true)
  })

  it('reads a git-dir from the option and from the GIT_DIR assignment', () => {
    expect(seen('git --git-dir=/x/.git restore f').at(-1)?.git?.gitDir).toBe('/x/.git')
    expect(seen('GIT_DIR=/y/.git git stash').at(-1)?.git?.gitDir).toBe('/y/.git')
  })

  it('marks an invocation it cannot pin down', () => {
    expect(seen('git -C "$X" checkout -- f').at(-1)?.git?.pinned).toBe(false)
  })

  it('is null for a program that is not git and for a git whose subcommand is a variable', () => {
    expect(seen('echo git commit').at(-1)?.git).toBeNull()
    expect(seen('git $SUB').at(-1)?.git).toBeNull()
  })

  it('carries a git under any path', () => {
    expect(seen('/usr/bin/git stash').at(-1)?.git?.subcommand).toBe('stash')
  })
})

describe('the shell parser has no side effect on import', () => {
  it('registers no exit listener when imported, which the guard does at its first statement', () => {
    const result = spawnSync('node', ['--input-type=module', '-e', `await import(${JSON.stringify(PARSER_FILE)}); process.stdout.write(String(process.listenerCount('exit')))`], { encoding: 'utf8' })
    expect(result.stdout).toBe('0')
    expect(result.status).toBe(0)
  })
})
