import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DESIGN_ORDER = ['instructions', 'tests-shrunk', 'src', 'docs-only', 'doubt']
const fixtures = path.dirname(fileURLToPath(import.meta.url))
const rulesModule = path.resolve(fixtures, '../../../morse/rules.ts')
const files = JSON.parse(readFileSync(path.join(fixtures, 'rules/shrunk-over-src-pos/files.json'), 'utf8'))

function refuse(message) {
  process.stderr.write(`world.sh check-order: ${message}\n`)
  process.exit(1)
}

async function loadRules() {
  try {
    return await import(pathToFileURL(rulesModule).href)
  }
  catch (error) {
    return refuse(`cannot load ${rulesModule}: ${error.message}`)
  }
}

function swapped(rules, first, second) {
  const ids = rules.map(rule => rule.id)
  return rules.map((rule) => {
    if (rule.id === first)
      return rules[ids.indexOf(second)]
    if (rule.id === second)
      return rules[ids.indexOf(first)]
    return rule
  })
}

const { RULES, classify } = await loadRules()
if (Array.isArray(RULES) === false || typeof classify !== 'function')
  refuse('rules.ts exports no RULES list and classify function')

const ids = RULES.map(rule => rule.id)
if (ids.join(' ') !== DESIGN_ORDER.join(' '))
  refuse(`RULES lists ${ids.join(' ')}, not ${DESIGN_ORDER.join(' ')}`)

const asListed = classify(files).rule
if (asListed !== 'tests-shrunk')
  refuse(`a src file with a shrunk test was decided by ${asListed}, not tests-shrunk`)

const reordered = classify(files, swapped(RULES, 'tests-shrunk', 'src')).rule
if (reordered !== 'src')
  refuse(`with src listed before tests-shrunk the same files were decided by ${reordered}, not src: the order is not read from the list`)

const again = classify(files).rule
if (again !== 'tests-shrunk')
  refuse(`after a reordered list, the default decided ${again}, not tests-shrunk`)
