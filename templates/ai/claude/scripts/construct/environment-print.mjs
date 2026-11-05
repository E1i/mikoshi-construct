import path from 'node:path'
import { scanCommand, walkCommands } from './shell-parser.mjs'

const END_OF_COMMAND = { kind: 'word', text: '', unresolvable: false, quoted: false, tilde: false, subs: [], redirect: false }
const ENVIRON_FILE = /(?:^|=)(\/proc\/\S*\/environ)$/
const LOOKUP_OPTION = /^-[a-z]*v/i

const isOption = word => word.text.startsWith('-')

const PRINTS_WITH_THESE_OPERANDS = {
  printenv: operands => operands.every(isOption),
  set: operands => operands.length === 0,
  export: operands => operands.every(word => word.text === '-p'),
}

function withCommandEnds(tokens) {
  return tokens.flatMap((token, index) => {
    if (token.kind !== 'word')
      return [token]
    const word = { ...token, subs: token.subs.map(withCommandEnds) }
    return tokens[index + 1]?.kind === 'word' ? [word] : [word, END_OF_COMMAND]
  })
}

function environFileIn(tokens) {
  for (const token of tokens) {
    if (token.kind !== 'word')
      continue
    const found = token.text.match(ENVIRON_FILE)?.[1] ?? token.subs.map(environFileIn).find(file => file != null)
    if (found != null)
      return found
  }
  return null
}

function onlyLooksUpTheName(prefixes) {
  return prefixes.some((word, index) => word.text === 'command' && LOOKUP_OPTION.test(prefixes[index + 1]?.text ?? ''))
}

function isBareEnv(prefixes) {
  return prefixes.some(word => !word.text.includes('=') && path.basename(word.text) === 'env')
}

function printingProgram({ words, index }) {
  const program = words[index]
  const prefixes = words.slice(0, index)
  if (onlyLooksUpTheName(prefixes))
    return null
  if (program === END_OF_COMMAND)
    return isBareEnv(prefixes) ? 'env' : null
  const name = path.basename(program.text)
  const operands = words.slice(index + 1).filter(word => word !== END_OF_COMMAND)
  return Object.hasOwn(PRINTS_WITH_THESE_OPERANDS, name) && PRINTS_WITH_THESE_OPERANDS[name](operands) ? name : null
}

function refusal(subject) {
  return [
    `Refused: ${subject}.`,
    'Why: what a call prints lands in the transcript and the logs, and an environment carries the session\'s tokens and keys; a printed secret cannot be taken back.',
    'Next: check one variable without printing its value, as test -n "$VAR".',
  ]
}

export function environmentPrintRefusal(command) {
  const tokens = scanCommand(command)
  const file = environFileIn(tokens)
  if (file != null)
    return refusal(`${file} names the environment of a process`)
  return walkCommands(withCommandEnds(tokens), null, (found) => {
    const program = printingProgram(found)
    return program == null ? null : refusal(`${program} with no variable or command prints the whole environment`)
  })
}
