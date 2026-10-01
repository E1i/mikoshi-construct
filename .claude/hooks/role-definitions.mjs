import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'

export const ROLES_JOURNAL_FILE = '.construct/roles.jsonl'
export const ROLE_DEFINITIONS_DIR = '.claude/agents'

const JOURNAL_VERSION = 1
const STATE_DIR = '.construct/turns.d'
const SNAPSHOT_SUFFIX = '.agents-sha'
const FAMILIES = ['sonnet', 'haiku', 'opus', 'fable']
const INHERIT = 'inherit'
const CHUNK = 65_536
const PLAIN_VALUE = /^[\w.:<>-]{1,128}$/

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function definitionNames(root) {
  try {
    return readdirSync(path.join(root, ROLE_DEFINITIONS_DIR), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort()
  }
  catch (error) {
    if (error.code === 'ENOENT')
      return []
    throw error
  }
}

export function definitionsDigest(root) {
  const pairs = definitionNames(root).map((name) => {
    const relative = `${ROLE_DEFINITIONS_DIR}/${name}`
    return `${relative}\0${sha256(readFileSync(path.join(root, relative)))}\n`
  })
  return sha256(pairs.join(''))
}

export function snapshotPath(root, session) {
  return path.join(root, STATE_DIR, `${session}${SNAPSHOT_SUFFIX}`)
}

export function appendRoleLine(root, line) {
  mkdirSync(path.join(root, '.construct'), { recursive: true })
  appendFileSync(path.join(root, ROLES_JOURNAL_FILE), `${JSON.stringify({ v: JOURNAL_VERSION, at: new Date().toISOString(), ...line })}\n`)
}

function plainValue(value) {
  return typeof value === 'string' && PLAIN_VALUE.test(value) ? value : null
}

function frontmatterModel(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---')
    return null
  for (const line of lines.slice(1)) {
    if (line === '---')
      return null
    const match = /^model:\s*["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (match != null)
      return match[1]
  }
  return null
}

export function declaredModel(root, agentType) {
  if (!/^[\w.:-]{1,128}$/.test(agentType) || agentType.includes('..'))
    return null
  try {
    return plainValue(frontmatterModel(readFileSync(path.join(root, ROLE_DEFINITIONS_DIR, `${agentType}.md`), 'utf8')))
  }
  catch (error) {
    if (error.code === 'ENOENT')
      return null
    throw error
  }
}

export function familyOf(model) {
  return typeof model === 'string' ? FAMILIES.find(family => model.includes(family)) ?? null : null
}

function modelOfLine(line) {
  try {
    const entry = JSON.parse(line)
    const message = entry?.message
    return message?.role === 'assistant' && familyOf(message.model) != null ? message.model : null
  }
  catch {
    return null
  }
}

export function lastAssistantModel(file) {
  const fd = openSync(file, 'r')
  try {
    let end = statSync(file).size
    let carry = ''
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const buffer = Buffer.alloc(end - start)
      readSync(fd, buffer, 0, end - start, start)
      const lines = (buffer.toString('utf8') + carry).split('\n')
      carry = start > 0 ? lines.shift() : ''
      for (const line of lines.reverse()) {
        const model = modelOfLine(line)
        if (model != null)
          return plainValue(model)
      }
      end = start
    }
    return null
  }
  finally {
    closeSync(fd)
  }
}

export function expectedModel(root, agentType, parentTranscript) {
  const declared = declaredModel(root, agentType)
  if (declared != null && declared !== INHERIT)
    return declared
  return typeof parentTranscript === 'string' && parentTranscript !== '' ? lastAssistantModel(parentTranscript) : null
}

export function modelMismatches({ session, agent, agentType, expected, actual }) {
  const family = familyOf(expected)
  return actual
    .filter(model => model !== 'other' && familyOf(model) !== family)
    .map(model => ({ kind: 'model-mismatch', session, agent, agentType, expected, actual: model }))
}
