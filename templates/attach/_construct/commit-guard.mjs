import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const verdict = { allowed: false }
process.on('exit', () => {
  process.exitCode = verdict.allowed ? 0 : 2
})

const PATTERNS = Symbol('patterns')
const GUARDED = ['commit', 'push', 'merge', 'rebase', 'tag']
const ALLOWED_FORMS = [
  ['tag'],
  ['tag', '-l', PATTERNS],
  ['tag', '--list', PATTERNS],
  ['merge', '--abort'],
  ['rebase', '--abort'],
]

const PROTECTED_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function matchesForm(form, words) {
  const variable = form.at(-1) === PATTERNS
  const fixed = variable ? form.slice(0, -1) : form
  if (words.length < fixed.length)
    return false
  if (!fixed.every((literal, index) => !words[index].unresolvable && words[index].text === literal))
    return false
  const rest = words.slice(fixed.length)
  return variable ? rest.every(word => !word.unresolvable && !word.text.startsWith('-')) : rest.length === 0
}

function isAllowedForm(words) {
  return ALLOWED_FORMS.some(form => matchesForm(form, words))
}

function sharesProtectedRepository(target, gitDir) {
  const environment = { ...process.env }
  delete environment.GIT_DIR
  delete environment.GIT_WORK_TREE
  delete environment.GIT_COMMON_DIR
  const cwd = target ?? path.dirname(gitDir)
  const gitDirArguments = gitDir == null ? [] : [`--git-dir=${gitDir}`]
  const result = spawnSync('git', [...gitDirArguments, 'rev-parse', '--git-common-dir'], { cwd, env: environment, encoding: 'utf8', timeout: 10000 })
  if (result.error != null || result.status !== 0)
    return false
  try {
    return realpathSync(path.resolve(cwd, result.stdout.trim())) === realpathSync(path.join(PROTECTED_ROOT, '.git'))
  }
  catch {
    return false
  }
}

function refusedAttached(subcommand) {
  return [
    `Refused: git ${subcommand} targets ${PROTECTED_ROOT}, a repository construct attach is attached to.`,
    'Why: in an attached repository the agent changes only the working tree and never commits, pushes, merges, rebases or tags; what reaches the history is what its owner has read.',
    'Next: leave the change uncommitted and report it as ready; the owner commits and pushes from their own terminal. There is no bypass for the agent; construct detach removes this guard.',
  ]
}

function refusedUnpinned(subcommand) {
  return [
    `Refused: git ${subcommand} targets a repository this guard cannot pin down: the path is held in a variable, comes from cd - or a command, names a directory that does not exist yet, or is not written out.`,
    `Why: ${PROTECTED_ROOT} is attached, and in an attached repository the agent never commits, pushes, merges, rebases or tags; a target the guard cannot read could be this one.`,
    `Next: name the repository literally, as git -C <path> ${subcommand} …; into another repository it then runs as before.`,
  ]
}

function guardWith(parser) {
  return command => guardCommand(parser, command)
}

function guardCommand(parser, command) {
  const git = parser.gitInvocation(command)
  if (git == null || !GUARDED.includes(git.subcommand) || (!command.appended && isAllowedForm(git.words)))
    return null
  if (!git.pinned)
    return refusedUnpinned(git.subcommand)
  if (sharesProtectedRepository(git.target, git.gitDir))
    return refusedAttached(git.subcommand)
  return null
}

function isObject(value) {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function decide(input, parser) {
  const command = isObject(input.tool_input) ? input.tool_input.command : undefined
  if (input.tool_name !== 'Bash' || typeof command !== 'string')
    return null
  const start = typeof input.cwd === 'string' && input.cwd !== '' ? path.resolve(input.cwd) : process.cwd()
  return parser.walkCommands(parser.scanCommand(command), start, guardWith(parser))
}
function fail(message) {
  process.stderr.write(`commit-guard: ${message}\n`)
}

function refuse(lines) {
  process.stderr.write(`${lines.join('\n')}\n`)
}

function refusedUnread(reason) {
  return [
    `Refused: the call could not be read, so this guard cannot tell whether it commits, pushes, merges, rebases or tags into ${PROTECTED_ROOT}: ${reason}.`,
    'Why: in an attached repository the agent never commits, pushes, merges, rebases or tags; a call the guard could not read could be one of those.',
    'Next: run the call again; if it is refused the same way, report it to the owner.',
  ]
}

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  let text
  try {
    text = await readInput()
  }
  catch (error) {
    refuse(refusedUnread(error instanceof Error ? error.message : String(error)))
    return
  }
  if (text === '') {
    refuse(refusedUnread('nothing arrived on stdin'))
    return
  }
  let input
  try {
    input = JSON.parse(text)
  }
  catch {
    fail('the input is not JSON, so nothing was checked')
    return
  }
  if (!isObject(input)) {
    fail('the input is not a JSON object, so nothing was checked')
    return
  }
  const parser = await import('./shell-parser.mjs')
  const refusal = decide(input, parser)
  if (refusal != null)
    refuse(refusal)
  else
    verdict.allowed = true
}

void (async () => {
  try {
    await main()
  }
  catch (error) {
    fail(`could not check the call: ${error instanceof Error ? error.message : String(error)}`)
  }
})()
