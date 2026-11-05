import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const { environmentPrintRefusal } = await import(path.join(REPO_ROOT, 'templates/attach/_construct/environment-print.mjs')) as { environmentPrintRefusal: (command: string) => string[] | null }
const CARRIER_DIRS = ['templates/attach/_construct', '.claude/hooks', 'templates/ai/claude/scripts/construct']
const REFUSAL = [expect.stringMatching(/^Refused: /), expect.stringMatching(/^Why: /), expect.stringMatching(/^Next: .*test -n "\$VAR"/)]

const REFUSED: Record<string, string> = {
  'env': 'env',
  'env under a path': '/usr/bin/env',
  'env with only options': 'env -0',
  'env with an unset and no command': 'env -u HOME',
  'env with an assignment and no command': 'env FOO=1',
  'env after a wrapper': 'sudo env',
  'env after command': 'command env',
  'env redirected': 'env > out.txt',
  'env in a pipeline': 'env | grep TOKEN',
  'env after a pipeline': 'ls | env',
  'env in a compound command': 'ls && env; pwd',
  'env in a subshell': '(env)',
  'env in a command substitution': 'echo "$(env)"',
  'env in backticks': 'echo `env`',
  'env in an assignment\'s substitution': 'X=$(env)',
  'printenv': 'printenv',
  'printenv under a path': '/usr/bin/printenv',
  'printenv with only options': 'printenv -0',
  'printenv in a pipeline': 'printenv | sort',
  'printenv in a substitution': 'echo $(printenv)',
  'set': 'set',
  'set redirected': 'set > out.txt',
  'set in a compound command': 'pwd; set',
  'export': 'export',
  'export -p': 'export -p',
  'export -p in a pipeline': 'export -p | grep KEY',
  '/proc/self/environ': 'cat /proc/self/environ',
  '/proc/<pid>/environ': 'cat /proc/1234/environ',
  '/proc/*/environ': 'cat /proc/*/environ',
  '/proc/$$/environ': 'cat /proc/$$/environ',
  '/proc environ as a redirect': 'tr "\\0" "\\n" < /proc/self/environ',
  '/proc environ quoted as a word': 'cat "/proc/self/environ"',
  '/proc environ as an option value': 'tool --file=/proc/self/environ',
  '/proc environ with a substituted pid': 'cat /proc/$(pgrep node)/environ',
  '/proc environ inside a substitution': 'echo $(cat /proc/1/environ)',
}

const PASSES: Record<string, string> = {
  'test -n of a variable': 'test -n "$HOME"',
  'the bracket form': '[ -n "$HOME" ]',
  'env with a command': 'env FOO=1 node script.js',
  'env with options and a command': 'env -i node script.js',
  'env under a path with a command': '/usr/bin/env node script.js',
  'env with a command in a variable': 'env $TOOL',
  'printenv NAME': 'printenv HOME',
  'printenv with an option and a name': 'printenv -0 HOME',
  'set -e': 'set -e',
  'set -- with arguments': 'set -- a b',
  'set -euo pipefail before a command': 'set -euo pipefail; pnpm test',
  'export of a name': 'export FOO=1',
  'export -p of a name': 'export -p FOO',
  'env inside a commit message': 'git commit -m "env"',
  'printenv inside a commit message': 'git commit -m "printenv"',
  'set inside a commit message': 'git commit -m "set"',
  'export -p inside a commit message': 'git commit -m "export -p"',
  'a sentence naming the environ file': 'git commit -m "cat /proc/self/environ"',
  'env as an argument': 'echo env',
  'command -v env': 'command -v env',
  'command -v printenv': 'command -v printenv',
  'type env': 'type env',
  'an assignment whose value ends in env': 'VIRTUAL=/opt/env',
  'env in a comment': 'ls # env',
  'env in a heredoc body': 'cat <<EOF\nenv\nEOF',
  'a /proc file that is not environ': 'cat /proc/self/status',
  'a file merely called environ': 'cat environ',
}

const SCRATCHES: string[] = []

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-environment-print-'))
  SCRATCHES.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of SCRATCHES)
    rmSync(dir, { recursive: true, force: true })
})

function inputFor(command: string, projectDir: string): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 's1', cwd: tmpdir(), transcript_path: path.join(projectDir, 'not-created-yet.jsonl') })
}

function runHook(script: string, args: string[], command: string, projectDir: string): { status: number | null, stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    input: inputFor(command, projectDir),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CONSTRUCT_HANDOFF_DIR: path.join(projectDir, 'handoff') },
  })
  return { status: result.status, stderr: result.stderr }
}

function eddiesProject(): string {
  const project = scratch()
  mkdirSync(path.join(project, '.claude'))
  writeFileSync(path.join(project, '.claude', 'eddies.json'), JSON.stringify({ contextLimit: 1e9, sessionSpend: 1e9, agentSpend: 1e9, runSpend: 1e9, warnRatio: 0.9 }))
  return project
}

function carrierCopy(sourceDir: string, files: string[]): string {
  const dir = scratch()
  for (const file of files)
    copyFileSync(path.join(REPO_ROOT, sourceDir, file), path.join(dir, file))
  return dir
}

const EDDIES_CARRIERS: Record<string, { dir: string, files: string[] }> = {
  'this repository\'s eddies hook': { dir: '.claude/hooks', files: ['eddies.mjs', 'eddies-measure.mjs', 'tab-window.mjs', 'environment-print.mjs', 'shell-parser.mjs'] },
  'an init repository\'s eddies hook': { dir: 'templates/ai/claude/scripts/construct', files: ['eddies.mjs', 'eddies-measure.mjs', 'window-hooks.mjs', 'environment-print.mjs', 'shell-parser.mjs'] },
}

const GUARD_FILES = ['commit-guard.mjs', 'environment-print.mjs', 'shell-parser.mjs']
const ATTACH_DIR = 'templates/attach/_construct'

describe('the environment-print refusal', () => {
  describe('each bare form is refused with its reason', () => {
    for (const [name, command] of Object.entries(REFUSED)) {
      it(name, () => {
        expect(environmentPrintRefusal(command)).toEqual(REFUSAL)
      })
    }
  })

  describe('test -n HOME and the neighbours pass', () => {
    for (const [name, command] of Object.entries(PASSES)) {
      it(name, () => {
        expect(environmentPrintRefusal(command)).toBeNull()
      })
    }
  })
})

describe('the eddies guard and the commit guard refuse env by exit 2 on hook input', () => {
  for (const [name, { dir, files }] of Object.entries(EDDIES_CARRIERS)) {
    it(`${name} refuses env and lets test -n "$HOME" through`, () => {
      const hooks = carrierCopy(dir, files)
      const project = eddiesProject()
      const refused = runHook(path.join(hooks, 'eddies.mjs'), ['guard'], 'env', project)

      expect(refused.status).toBe(2)
      expect(refused.stderr).toMatch(/^Refused: env .*\nWhy: .*\nNext: .*\n$/)
      expect(runHook(path.join(hooks, 'eddies.mjs'), ['guard'], 'test -n "$HOME"', project).status).not.toBe(2)
    })

    it(`${name} refuses when the module cannot load`, () => {
      const hooks = carrierCopy(dir, files.filter(file => file !== 'environment-print.mjs'))
      const refused = runHook(path.join(hooks, 'eddies.mjs'), ['guard'], 'test -n "$HOME"', eddiesProject())

      expect(refused.status).toBe(2)
      expect(refused.stderr).toContain('environment-print-unloadable')
    })
  }

  it('the commit guard refuses env and lets test -n "$HOME" through', () => {
    const construct = path.join(carrierCopy(ATTACH_DIR, []), '.construct')
    mkdirSync(construct)
    for (const file of GUARD_FILES)
      copyFileSync(path.join(REPO_ROOT, ATTACH_DIR, file), path.join(construct, file))
    const guard = path.join(construct, 'commit-guard.mjs')
    const refused = runHook(guard, [], 'env', scratch())

    expect(refused.status).toBe(2)
    expect(refused.stderr).toMatch(/^Refused: env .*\nWhy: .*\nNext: .*\n$/)
    expect(runHook(guard, [], 'test -n "$HOME"', scratch())).toMatchObject({ status: 0, stderr: '' })
  })

  it('the commit guard refuses when the module cannot load', () => {
    const construct = path.join(carrierCopy(ATTACH_DIR, []), '.construct')
    mkdirSync(construct)
    for (const file of GUARD_FILES.filter(name => name !== 'environment-print.mjs'))
      copyFileSync(path.join(REPO_ROOT, ATTACH_DIR, file), path.join(construct, file))
    const refused = runHook(path.join(construct, 'commit-guard.mjs'), [], 'test -n "$HOME"', scratch())

    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('commit-guard: could not check the call')
  })
})

describe('the carriers', () => {
  for (const module of ['environment-print.mjs', 'shell-parser.mjs']) {
    it(`every copy of the module and the parser is byte-identical: ${module}`, () => {
      const [source, ...copies] = CARRIER_DIRS.map(dir => readFileSync(path.join(REPO_ROOT, dir, module)))
      for (const copy of copies)
        expect(copy.equals(source!)).toBe(true)
    })
  }
})
