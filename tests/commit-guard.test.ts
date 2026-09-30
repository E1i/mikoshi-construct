import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const GUARD = '.construct/commit-guard.mjs'
const ui = createUi(resolveTheme({ plain: true }), silentWriter)

const worlds: string[] = []

interface World {
  attached: string
  other: string
  worktree: string
}

let world: World

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
}

function repository(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-commit-guard-')))
  worlds.push(dir)
  git(dir, 'init', '-q')
  writeFileSync(path.join(dir, 'main.go'), 'package main\n')
  git(dir, 'add', 'main.go')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

beforeAll(async () => {
  const attached = repository()
  const other = repository()
  mkdirSync(path.join(attached, 'sub'))
  const holder = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-commit-guard-worktree-')))
  worlds.push(holder)
  const worktree = path.join(holder, 'wt')
  git(attached, 'worktree', 'add', '-q', '--detach', worktree)
  const result = await runAttach(ui, { dir: attached, harness: 'true', yes: true })
  expect(result.status).toBe('done')
  world = { attached, other, worktree }
})

afterAll(() => {
  for (const dir of worlds)
    rmSync(dir, { recursive: true, force: true })
})

function runGuard(stdin: string): { status: number | null, stderr: string, stdout: string } {
  const result = spawnSync('node', [path.join(world.attached, GUARD)], { input: stdin, encoding: 'utf8', cwd: world.attached })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

function bash(command: string, from: string): ReturnType<typeof runGuard> {
  return runGuard(JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: from }))
}

type Place = 'attached' | 'other' | 'sub' | 'worktree'
type Outcome = 'attached' | 'unpinned' | 'passes'

interface Case {
  command: string
  from: Place
  outcome: Outcome
  subcommand?: string
}

function place(name: Place): string {
  return { attached: world.attached, other: world.other, sub: path.join(world.attached, 'sub'), worktree: world.worktree }[name]
}

function filled(command: string): string {
  return command.replaceAll('{R}', world.attached).replaceAll('{O}', world.other).replaceAll('{W}', world.worktree)
}

const HEREDOC_COMMIT = 'git -C {O} commit -m "$(cat <<\'EOF\'\nit\'s done\nEOF\n)"'

const CASES: Record<string, Case> = {
  'commit from the attached root is refused': { command: 'git commit -m x', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'push from a subdirectory is refused': { command: 'git push', from: 'sub', outcome: 'attached', subcommand: 'push' },
  'commit through -C from another repository is refused': { command: 'git -C {R} commit -m x', from: 'other', outcome: 'attached', subcommand: 'commit' },
  'commit through a quoted -C is refused': { command: 'git -C "{R}" commit -m x', from: 'other', outcome: 'attached', subcommand: 'commit' },
  'commit through -c is refused': { command: 'git -c user.name=a commit -m x', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'commit through --git-dir is refused': { command: 'git --git-dir={R}/.git commit -m x', from: 'other', outcome: 'attached', subcommand: 'commit' },
  'push behind an assignment and --no-pager is refused': { command: 'FOO=1 git --no-pager push origin main', from: 'attached', outcome: 'attached', subcommand: 'push' },
  'commit after a leading cd is refused': { command: 'cd {R} && git commit -m x', from: 'other', outcome: 'attached', subcommand: 'commit' },
  'commit after another command is refused': { command: 'echo ok; git commit -am x', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'push inside a subshell is refused': { command: '(cd {R} && git push)', from: 'other', outcome: 'attached', subcommand: 'push' },
  'commit into a worktree of the attached repository is refused': { command: 'git -C {W} commit -m x', from: 'other', outcome: 'attached', subcommand: 'commit' },
  'merge is refused': { command: 'git merge main', from: 'attached', outcome: 'attached', subcommand: 'merge' },
  'rebase is refused': { command: 'git rebase main', from: 'attached', outcome: 'attached', subcommand: 'rebase' },
  'tag with a name is refused': { command: 'git tag v1', from: 'attached', outcome: 'attached', subcommand: 'tag' },
  'tag -d is refused': { command: 'git tag -d v1', from: 'attached', outcome: 'attached', subcommand: 'tag' },
  'tag -l x && tag y refuses the second command': { command: 'git tag -l x && git tag y', from: 'attached', outcome: 'attached', subcommand: 'tag' },
  'tag -list-something is not tag -l': { command: 'git tag -list-something', from: 'attached', outcome: 'attached', subcommand: 'tag' },
  'tag -l x -d y is refused': { command: 'git tag -l x -d y', from: 'attached', outcome: 'attached', subcommand: 'tag' },
  'tag -l -d v1 is refused': { command: 'git tag -l -d v1', from: 'attached', outcome: 'attached', subcommand: 'tag' },
  'merge --continue is refused': { command: 'git merge --continue', from: 'attached', outcome: 'attached', subcommand: 'merge' },
  'rebase --continue is refused': { command: 'git rebase --continue', from: 'attached', outcome: 'attached', subcommand: 'rebase' },
  'rebase -i is refused': { command: 'git rebase -i HEAD~1', from: 'attached', outcome: 'attached', subcommand: 'rebase' },

  'a bare tag passes': { command: 'git tag', from: 'attached', outcome: 'passes' },
  'tag -l passes': { command: 'git tag -l', from: 'attached', outcome: 'passes' },
  'tag -l with a pattern passes': { command: 'git tag -l "v*"', from: 'attached', outcome: 'passes' },
  'tag --list passes': { command: 'git tag --list', from: 'attached', outcome: 'passes' },
  'tag --list with a pattern passes': { command: 'git tag --list v1', from: 'attached', outcome: 'passes' },
  'merge --abort passes': { command: 'git merge --abort', from: 'attached', outcome: 'passes' },
  'rebase --abort passes': { command: 'git rebase --abort', from: 'attached', outcome: 'passes' },

  'a path in a variable is refused as unpinned': { command: 'git -C "$D" commit -m x', from: 'attached', outcome: 'unpinned', subcommand: 'commit' },
  'cd - is refused as unpinned': { command: 'cd - && git commit -m x', from: 'other', outcome: 'unpinned', subcommand: 'commit' },
  'an unquoted variable is refused as unpinned': { command: 'cd $HOME/x && git push', from: 'other', outcome: 'unpinned', subcommand: 'push' },
  'an unresolvable --git-dir is refused as unpinned': { command: 'git --git-dir=$G tag v3', from: 'other', outcome: 'unpinned', subcommand: 'tag' },
  'tag -l on an unpinned target passes': { command: 'git -C "$D" tag -l', from: 'other', outcome: 'passes' },
  'a log on an unpinned target passes': { command: 'git -C "$D" log --grep commit', from: 'other', outcome: 'passes' },

  'commit into another repository passes': { command: 'git commit -m x', from: 'other', outcome: 'passes' },
  'merge into another repository passes': { command: 'git merge main', from: 'other', outcome: 'passes' },
  'tag into another repository passes': { command: 'git tag v1', from: 'other', outcome: 'passes' },
  'commit through -C into another repository passes': { command: 'git -C {O} commit -m x', from: 'attached', outcome: 'passes' },
  'commit after cd into another repository passes': { command: 'cd {O} && git commit -m x', from: 'attached', outcome: 'passes' },
  'the words inside a quoted string pass': { command: 'echo "git commit"', from: 'attached', outcome: 'passes' },
  'a commit wrapped in bash -c passes': { command: 'bash -c "git commit"', from: 'attached', outcome: 'passes' },
  'the words in a comment pass': { command: 'echo commit # git push', from: 'attached', outcome: 'passes' },
  'status passes': { command: 'git status', from: 'attached', outcome: 'passes' },
  'log --grep commit passes': { command: 'git log --grep commit', from: 'attached', outcome: 'passes' },
  'help commit passes': { command: 'git help commit', from: 'attached', outcome: 'passes' },
  'commit-tree passes': { command: 'git commit-tree HEAD^{tree}', from: 'attached', outcome: 'passes' },
  'cherry-pick passes': { command: 'git cherry-pick HEAD', from: 'attached', outcome: 'passes' },
  'revert passes': { command: 'git revert HEAD', from: 'attached', outcome: 'passes' },
  'am passes': { command: 'git am x.patch', from: 'attached', outcome: 'passes' },
  'stash passes': { command: 'git stash', from: 'attached', outcome: 'passes' },
  'a read in a worktree passes': { command: 'git -C {W} status', from: 'other', outcome: 'passes' },

  'a commit in a subshell that moved to another repository passes': { command: '(cd {O} && git commit -m x)', from: 'attached', outcome: 'passes' },
  'a commit after a subshell that moved is still in the attached repository': { command: '(cd {O}) && git commit -m x', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'merge --abort with a redirection passes': { command: 'git merge --abort 2>&1', from: 'attached', outcome: 'passes' },
  'commit with a redirection is refused': { command: 'git commit -m x 2>&1', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'commit after if is refused': { command: 'if true; then git commit -m x; fi', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'status after if passes': { command: 'if true; then git status; fi', from: 'attached', outcome: 'passes' },
  'a -C from a substitution is refused as unpinned': { command: 'git -C "$(pwd)" commit -m x', from: 'attached', outcome: 'unpinned', subcommand: 'commit' },
  'a status through a -C from a substitution passes': { command: 'git -C "$(pwd)" status', from: 'attached', outcome: 'passes' },
  'a commit inside a substitution is refused': { command: 'echo $(git commit -m x)', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'a cd into a missing directory leaves the commit unpinned': { command: 'cd {R}/does-not-exist; git commit -m x', from: 'attached', outcome: 'unpinned', subcommand: 'commit' },
  'a cd into another repository, then a commit, passes': { command: 'cd {O}; git commit -m x', from: 'attached', outcome: 'passes' },
  'a here-document message with an apostrophe passes': { command: HEREDOC_COMMIT, from: 'attached', outcome: 'passes' },
  'a push after that here-document is refused': { command: `${HEREDOC_COMMIT} && git push`, from: 'attached', outcome: 'attached', subcommand: 'push' },
  'env -u before a commit is refused': { command: 'env -u FOO git commit -m x', from: 'attached', outcome: 'attached', subcommand: 'commit' },
  'env with an assignment before a commit is refused': { command: 'env GIT_PAGER=cat git commit', from: 'attached', outcome: 'attached', subcommand: 'commit' },
}

describe('the installed commit guard, one row per case', () => {
  for (const [name, row] of Object.entries(CASES)) {
    it(name, () => {
      const result = bash(filled(row.command), place(row.from))

      if (row.outcome === 'passes') {
        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout).toBe('')
        return
      }
      const lines = result.stderr.trimEnd().split('\n')
      expect(result.status).toBe(2)
      expect(lines).toHaveLength(3)
      expect(lines[0]).toMatch(new RegExp(`^Refused: git ${row.subcommand} targets `))
      expect(lines[1]).toMatch(/^Why: /)
      expect(lines[2]).toMatch(/^Next: /)
      if (row.outcome === 'attached') {
        expect(lines[0]).toContain(world.attached)
        expect(lines[2]).toContain('There is no bypass for the agent; construct detach removes this guard.')
      }
      else {
        expect(lines[0]).toContain('cannot pin down')
        expect(lines[2]).toContain('git -C <path>')
      }
    })
  }
})

describe('the installed commit guard, what it is given', () => {
  it('lets a call to another tool through', () => {
    const result = runGuard(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: world.attached }))

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  for (const [name, stdin] of Object.entries({ 'text that is not JSON': 'not json', 'a JSON array': '[]', 'JSON null': 'null' })) {
    it(`exits 1 with a line on stderr for ${name}, so a call that was not checked never reads as one that was`, () => {
      const result = runGuard(stdin)

      expect(result.status).toBe(1)
      expect(result.stderr.trim().split('\n')).toHaveLength(1)
    })
  }
})

describe('the installed commit guard, what it is', () => {
  it('reads no environment variable to let a call through, so a variable the session sets does not open it', () => {
    const source = readFileSync(path.join(world.attached, GUARD), 'utf8')
    const result = spawnSync('node', [path.join(world.attached, GUARD)], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: world.attached }),
      encoding: 'utf8',
      env: { ...process.env, CONSTRUCT_ALLOW_COMMIT: '1', CLAUDE_PROJECT_DIR: world.other },
    })

    expect(source).not.toContain('CONSTRUCT_ALLOW')
    expect(result.status).toBe(2)
  })
})
