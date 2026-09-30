import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PATTERNS = Symbol('patterns')
const GUARDED = ['commit', 'push', 'merge', 'rebase', 'tag']
const ALLOWED_FORMS = [
  ['tag'],
  ['tag', '-l', PATTERNS],
  ['tag', '--list', PATTERNS],
  ['merge', '--abort'],
  ['rebase', '--abort'],
]

const GIT_WORD = /\bgit\b/
const GUARDED_WORD = new RegExp(`\\b(?:${GUARDED.join('|')})\\b`)
const ASSIGNMENT = /^[A-Z_]\w*=/i
const PROTECTED_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RESERVED = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until'])
const TRANSPARENT = new Set(['command', 'exec', 'time', 'nohup'])
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-S', '--split-string'])
const ENV_CHDIR_OPTIONS = new Set(['-C', '--chdir'])
const GIT_VALUE_OPTIONS = new Set(['-c', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
const PIPING = new Set(['|', '|&', '&'])
const UNKNOWN = Symbol('unknown')

function newWord() {
  return { kind: 'word', text: '', unresolvable: false, quoted: false, tilde: false, subs: [], redirect: false }
}

class Scanner {
  constructor(source, position, closer) {
    this.source = source
    this.position = position
    this.closer = closer
    this.tokens = []
    this.word = null
    this.heredocs = []
    this.expect = null
    this.depth = 0
    this.closed = false
  }

  peek(offset = 0) {
    return this.source[this.position + offset]
  }

  current() {
    if (this.word == null) {
      this.word = newWord()
      this.word.redirect = this.expect != null
    }
    return this.word
  }

  endWord() {
    const word = this.word
    if (word == null)
      return
    this.word = null
    if (word.tilde) {
      if (word.text === '~' || word.text.startsWith('~/'))
        word.text = os.homedir() + word.text.slice(1)
      else
        word.unresolvable = true
    }
    if (this.expect?.heredoc === true)
      this.heredocs.push({ delimiter: word.text, strip: this.expect.strip })
    if (word.redirect)
      this.expect = null
    this.tokens.push(word)
  }

  emit(operator) {
    this.expect = null
    this.tokens.push({ kind: 'op', op: operator })
  }

  finish() {
    this.endWord()
    return this.tokens
  }

  consume() {
    while (this.position < this.source.length && !this.closed) {
      const character = this.peek()
      if (character === ' ' || character === '\t' || character === '\r') {
        this.endWord()
        this.position += 1
      }
      else if (character === '\n') {
        this.endWord()
        this.position += 1
        this.emit('\n')
        this.skipHeredocBodies()
      }
      else if (character === '\\') {
        this.escape()
      }
      else if (character === '\'') {
        this.singleQuoted()
      }
      else if (character === '"') {
        this.doubleQuoted()
      }
      else if (character === '`') {
        this.backtick(this.closer === '`' ? null : this.current())
      }
      else if (character === '$') {
        this.dollar()
      }
      else if ((character === '<' || character === '>') && this.peek(1) === '(') {
        const word = this.current()
        this.position += 1
        this.substitution(word)
      }
      else if (character === '<' || character === '>' || (character === '&' && this.peek(1) === '>')) {
        this.redirection()
      }
      else if (character === '#' && this.word == null) {
        this.comment()
      }
      else if (';&|()'.includes(character)) {
        this.operator(character)
      }
      else {
        this.literal(character)
      }
    }
  }

  literal(character) {
    const fresh = this.word == null
    const word = this.current()
    if ('*?['.includes(character))
      word.unresolvable = true
    if (fresh && character === '~')
      word.tilde = true
    word.text += character
    this.position += 1
  }

  escape() {
    const next = this.peek(1)
    if (next == null) {
      this.position += 1
      return
    }
    this.position += 2
    if (next === '\n')
      return
    const word = this.current()
    word.quoted = true
    word.text += next
  }

  singleQuoted() {
    const word = this.current()
    word.quoted = true
    const end = this.source.indexOf('\'', this.position + 1)
    if (end === -1) {
      word.unresolvable = true
      word.text += this.source.slice(this.position + 1)
      this.position = this.source.length
      return
    }
    word.text += this.source.slice(this.position + 1, end)
    this.position = end + 1
  }

  doubleQuoted() {
    const word = this.current()
    word.quoted = true
    this.position += 1
    while (this.position < this.source.length) {
      const character = this.peek()
      const next = this.peek(1)
      if (character === '"') {
        this.position += 1
        return
      }
      if (character === '\\' && next != null) {
        if (next !== '\n')
          word.text += '$`"\\'.includes(next) ? next : character + next
        this.position += 2
      }
      else if (character === '$' && next === '(') {
        this.substitution(word)
      }
      else if (character === '`') {
        this.backtick(word)
      }
      else {
        if (character === '$')
          word.unresolvable = true
        word.text += character
        this.position += 1
      }
    }
    word.unresolvable = true
  }

  dollar() {
    const word = this.current()
    if (this.peek(1) === '(') {
      this.substitution(word)
      return
    }
    word.unresolvable = true
    word.text += '$'
    this.position += 1
  }

  substitution(word) {
    const inner = new Scanner(this.source, this.position + 2, ')')
    inner.consume()
    word.subs.push(inner.finish())
    word.unresolvable = true
    this.position = inner.position
  }

  backtick(word) {
    if (word == null) {
      this.endWord()
      this.position += 1
      this.closed = true
      return
    }
    const inner = new Scanner(this.source, this.position + 1, '`')
    inner.consume()
    word.subs.push(inner.finish())
    word.unresolvable = true
    this.position = inner.position
  }

  redirection() {
    const word = this.word
    if (word != null && /^\d+$/.test(word.text) && !word.quoted && word.subs.length === 0)
      this.word = null
    else
      this.endWord()
    if (this.peek() === '<' && this.peek(1) === '<' && this.peek(2) !== '<') {
      this.position += 2
      const strip = this.peek() === '-'
      if (strip)
        this.position += 1
      this.expect = { heredoc: true, strip }
      return
    }
    this.position += 1
    while (this.position < this.source.length && '<>&|'.includes(this.peek()))
      this.position += 1
    this.expect = { heredoc: false, strip: false }
  }

  skipHeredocBodies() {
    for (const { delimiter, strip } of this.heredocs.splice(0)) {
      while (this.position < this.source.length) {
        const found = this.source.indexOf('\n', this.position)
        const end = found === -1 ? this.source.length : found
        const line = this.source.slice(this.position, end)
        this.position = found === -1 ? end : end + 1
        if ((strip ? line.replace(/^\t+/, '') : line) === delimiter)
          break
      }
    }
  }

  comment() {
    const found = this.source.indexOf('\n', this.position)
    this.position = found === -1 ? this.source.length : found
  }

  operator(character) {
    this.endWord()
    const pair = character + (this.peek(1) ?? '')
    if (character === ')') {
      this.position += 1
      if (this.closer === ')' && this.depth === 0) {
        this.closed = true
        return
      }
      this.depth = Math.max(0, this.depth - 1)
      this.emit(')')
      return
    }
    if (character === '(') {
      this.depth += 1
      this.position += 1
      this.emit('(')
      return
    }
    const operator = ['&&', '||', '|&'].includes(pair) ? pair : character
    this.position += operator.length
    this.emit(operator)
  }
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory()
  }
  catch {
    return false
  }
}

function moved(directory, operand) {
  if (operand.unresolvable)
    return null
  if (operand.text === '')
    return directory
  const resolved = path.isAbsolute(operand.text) ? operand.text : directory == null ? null : path.resolve(directory, operand.text)
  return resolved != null && isDirectory(resolved) ? resolved : null
}

function changeDirectory(name, operands, directory) {
  if (name === 'popd')
    return null
  const first = operands.findIndex(word => !word.text.startsWith('-') || word.text === '-')
  const rest = first === -1 ? [] : operands.slice(first)
  if (rest.length === 0)
    return name === 'pushd' ? null : os.homedir()
  if (rest[0].text === '-')
    return null
  return moved(directory, rest[0])
}

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

function pinnedDirectory(target, operand) {
  if (operand == null)
    return target
  if (operand.unresolvable)
    return null
  if (operand.text === '')
    return target
  if (path.isAbsolute(operand.text))
    return operand.text
  return target == null ? null : path.resolve(target, operand.text)
}

function resolvedGitDir(gitDir, target) {
  if (gitDir == null)
    return null
  if (gitDir.unresolvable || gitDir.value === '')
    return UNKNOWN
  if (path.isAbsolute(gitDir.value))
    return gitDir.value
  return target == null ? UNKNOWN : path.resolve(target, gitDir.value)
}

function readGitCommand(words, start, directory, gitDirFromEnvironment) {
  let target = directory
  let gitDir = gitDirFromEnvironment
  let cursor = start
  while (cursor < words.length) {
    const word = words[cursor]
    if (!word.text.startsWith('-') || word.text === '-') {
      if (word.unresolvable)
        return null
      return { subcommand: word.text, words: words.slice(cursor), target, gitDir: resolvedGitDir(gitDir, target) }
    }
    if (word.text === '-C') {
      target = pinnedDirectory(target, words[cursor + 1])
      cursor += 2
    }
    else if (word.text === '--git-dir') {
      const operand = words[cursor + 1]
      gitDir = operand == null ? gitDir : { value: operand.text, unresolvable: operand.unresolvable }
      cursor += 2
    }
    else if (word.text.startsWith('--git-dir=')) {
      gitDir = { value: word.text.slice('--git-dir='.length), unresolvable: word.unresolvable }
      cursor += 1
    }
    else {
      cursor += GIT_VALUE_OPTIONS.has(word.text) ? 2 : 1
    }
  }
  return null
}

function skipPrefixes(words) {
  let index = 0
  let gitDir = null
  let unknown = false
  while (index < words.length) {
    const word = words[index]
    if (ASSIGNMENT.test(word.text)) {
      if (word.text.startsWith('GIT_DIR='))
        gitDir = { value: word.text.slice('GIT_DIR='.length), unresolvable: word.unresolvable }
      index += 1
    }
    else if (word.unresolvable) {
      break
    }
    else if (!word.quoted && RESERVED.has(word.text)) {
      index += 1
    }
    else if (TRANSPARENT.has(word.text)) {
      index += 1
      while (index < words.length && words[index].text.startsWith('-') && !words[index].unresolvable)
        index += 1
    }
    else if (word.text === 'env') {
      index += 1
      while (index < words.length && words[index].text.startsWith('-') && words[index].text !== '-') {
        const option = words[index].text
        if (option === '--') {
          index += 1
          break
        }
        if (ENV_VALUE_OPTIONS.has(option) || ENV_CHDIR_OPTIONS.has(option))
          index += 2
        else
          index += 1
        if (ENV_CHDIR_OPTIONS.has(option) || option.startsWith('--chdir='))
          unknown = true
      }
    }
    else {
      break
    }
  }
  return { index, gitDir, unknown }
}

function simpleCommand(words, directory, before, after) {
  for (const word of words) {
    for (const sub of word.subs) {
      const refusal = walk(sub, directory)
      if (refusal != null)
        return { refusal }
    }
  }
  const active = words.filter(word => !word.redirect)
  const { index, gitDir, unknown } = skipPrefixes(active)
  const program = active[index]
  if (program == null)
    return { directory }
  if (['cd', 'pushd', 'popd'].includes(program.text)) {
    const next = changeDirectory(program.text, active.slice(index + 1), directory)
    return { directory: PIPING.has(before) || PIPING.has(after) ? null : next }
  }
  if (path.basename(program.text) !== 'git')
    return { directory }
  const command = readGitCommand(active, index + 1, unknown ? null : directory, gitDir)
  if (command == null || !GUARDED.includes(command.subcommand) || isAllowedForm(command.words))
    return { directory }
  const pinned = command.gitDir == null ? command.target != null : command.gitDir !== UNKNOWN
  if (!pinned)
    return { directory, refusal: refusedUnpinned(command.subcommand) }
  const gitDirValue = command.gitDir === UNKNOWN ? null : command.gitDir
  if (sharesProtectedRepository(command.target, gitDirValue))
    return { directory, refusal: refusedAttached(command.subcommand) }
  return { directory }
}

function walk(tokens, startDirectory) {
  let directory = startDirectory
  const saved = []
  let words = []
  let before = ';'
  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index]
    if (token?.kind === 'word') {
      words.push(token)
      continue
    }
    const operator = token?.op
    const joiner = PIPING.has(operator) ? operator : ';'
    if (words.length > 0) {
      const outcome = simpleCommand(words, directory, before, joiner)
      if (outcome.refusal != null)
        return outcome.refusal
      directory = outcome.directory
    }
    words = []
    if (operator === '(')
      saved.push(directory)
    else if (operator === ')' && saved.length > 0)
      directory = saved.pop()
    before = joiner
  }
  return null
}

function isObject(value) {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function decide(input) {
  const command = isObject(input.tool_input) ? input.tool_input.command : undefined
  if (input.tool_name !== 'Bash' || typeof command !== 'string')
    return null
  if (!GIT_WORD.test(command) || !GUARDED_WORD.test(command))
    return null
  const scanner = new Scanner(command, 0, null)
  scanner.consume()
  const start = typeof input.cwd === 'string' && input.cwd !== '' ? path.resolve(input.cwd) : process.cwd()
  return walk(scanner.finish(), start)
}

function fail(message) {
  process.stderr.write(`commit-guard: ${message}\n`)
  process.exitCode = 1
}

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  }
  catch {
    fail('the input is not JSON, so nothing was checked')
    return
  }
  if (!isObject(input)) {
    fail('the input is not a JSON object, so nothing was checked')
    return
  }
  const refusal = decide(input)
  if (refusal == null)
    return
  process.stderr.write(`${refusal.join('\n')}\n`)
  process.exitCode = 2
}

try {
  main()
}
catch (error) {
  fail(`could not check the call: ${error instanceof Error ? error.message : String(error)}`)
}
