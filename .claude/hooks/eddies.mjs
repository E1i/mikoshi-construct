import { Buffer } from 'node:buffer'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const EDDIES_JOURNAL_FILE = '.construct/eddies.jsonl'

const MEASURE_MODULE = './eddies-measure.mjs'
const CONFIG_FILE = '.claude/eddies.json'
const WARNED_DIR = '.construct/eddies.d/warned'
const TASK_CACHE_DIR = '.construct/eddies.d/task'
const HANDOFF_DIR_VARIABLE = 'CONSTRUCT_HANDOFF_DIR'
const GHOST_JOURNAL = 'ghosts.jsonl'
const JOURNAL_VERSION = 1
const THRESHOLDS = ['contextLimit', 'sessionSpend', 'agentSpend', 'runSpend', 'warnRatio']
const NEW_WORK_TOOLS = ['Agent', 'Workflow']
const NESTED_SESSION = /\bclaude\b[^\n;&|]*\s(?:-p|--print)(?=\s|$)/
const GHOST_LAUNCH = /\bghosts:launch\b/
const RETURN_TOOL = 'SubagentHandback'
const SESSION_ACTION = 'no new work — write the handoff and stop'
const AGENT_ACTION = 'return what you have now'
const WARN_ACTION = 'finish the current step, save (milestone commit / handoff), start no new work'
const PLAIN_ID = /^[\w-]{1,128}$/
const PLAIN_REASON = /^[\w.:-]{1,64}$/
const WINDOW = 'window'
const AGENT_TRANSCRIPT_MISSING = 'agent-transcript-missing'

class Unread extends Error {}

function plainId(value) {
  return typeof value === 'string' && PLAIN_ID.test(value) ? value : null
}

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin)
    chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function parsedInput(text) {
  try {
    const input = JSON.parse(text)
    return input != null && typeof input === 'object' && !Array.isArray(input) ? input : null
  }
  catch {
    return null
  }
}

function projectRoot() {
  const root = process.env.CLAUDE_PROJECT_DIR
  return root != null && root !== '' && existsSync(root) && statSync(root).isDirectory() ? root : null
}

function readConfig(root) {
  let text
  try {
    text = readFileSync(path.join(root, CONFIG_FILE), 'utf8')
  }
  catch (error) {
    throw new Unread(error.code === 'ENOENT' ? 'config-missing' : 'config-unreadable')
  }
  const config = parsedInput(text)
  if (config == null)
    throw new Unread('config-not-an-object')
  for (const key of THRESHOLDS) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      throw new Unread(`config-${key}-invalid`)
  }
  if (config.warnRatio > 1)
    throw new Unread('config-warnRatio-invalid')
  return config
}

function ghostJournalPath() {
  const dir = process.env[HANDOFF_DIR_VARIABLE]
  return path.join(dir != null && dir !== '' ? dir : path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
}

function startedTaskIn(text, session) {
  let task = null
  for (const line of text.split('\n')) {
    const entry = parsedInput(line)
    if (entry?.event === 'path' && entry.session === session && entry.started !== undefined && plainId(entry.task) != null)
      task = entry.task
  }
  return task
}

function readCache(file) {
  try {
    return parsedInput(readFileSync(file, 'utf8'))
  }
  catch {
    return null
  }
}

function taskOf(root, session) {
  if (session == null)
    return null
  try {
    const journalPath = ghostJournalPath()
    const size = existsSync(journalPath) ? statSync(journalPath).size : 0
    const cacheFile = path.join(root, TASK_CACHE_DIR, `${session}.json`)
    const cached = readCache(cacheFile)
    if (cached != null && (cached.task != null || cached.size === size))
      return cached.task
    const task = size === 0 ? null : startedTaskIn(readFileSync(journalPath, 'utf8'), session)
    mkdirSync(path.dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({ size, task }))
    return task
  }
  catch {
    return null
  }
}

function journal(root, line) {
  mkdirSync(path.join(root, '.construct'), { recursive: true })
  const task = taskOf(root, line.session_id ?? null)
  appendFileSync(path.join(root, EDDIES_JOURNAL_FILE), `${JSON.stringify({ v: JOURNAL_VERSION, ...line, ...(task == null ? {} : { task }), at: new Date().toISOString() })}\n`)
}

function callerOf(input) {
  return { session_id: plainId(input.session_id), agent_id: plainId(input.agent_id), agent_type: plainId(input.agent_type) }
}

function isNewWork(input) {
  if (NEW_WORK_TOOLS.includes(input.tool_name))
    return true
  const command = input.tool_name === 'Bash' ? input.tool_input?.command : null
  return typeof command === 'string' && (NESTED_SESSION.test(command) || GHOST_LAUNCH.test(command))
}

function transcriptOf(input) {
  if (typeof input.transcript_path !== 'string' || !path.isAbsolute(input.transcript_path))
    throw new Unread('no-transcript-path')
  return input.transcript_path
}

function subagentsDirOf(transcript) {
  return path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
}

function sessionGauges({ addTokens, agentTranscriptsUnder, CONTEXT_BASIS, contextOf, readTranscript, SPEND_BASIS, spentOf, sumTranscripts }, root, transcript, config, caller) {
  const parent = readTranscript(root, transcript)
  const others = sumTranscripts(root, agentTranscriptsUnder(subagentsDirOf(transcript)))
  const spend = addTokens({ ...parent.tokens }, others)
  const recipient = `${caller.session_id}.${caller.agent_id ?? WINDOW}`
  return [
    { level: 'session-context', key: recipient, name: 'context', value: contextOf(parent.last), limitName: 'contextLimit', limit: config.contextLimit, tokens: parent.last, basis: CONTEXT_BASIS, action: SESSION_ACTION },
    { level: 'session-spend', key: recipient, name: 'spent', value: spentOf(spend), limitName: 'sessionSpend', limit: config.sessionSpend, tokens: spend, basis: SPEND_BASIS, action: SESSION_ACTION },
  ]
}

function agentFileOf(agentTranscriptsUnder, transcript, agentId) {
  const name = `agent-${agentId}.jsonl`
  const subagents = subagentsDirOf(transcript)
  if (existsSync(path.join(subagents, name)))
    return { file: path.join(subagents, name), runId: null }
  const found = agentTranscriptsUnder(path.join(subagents, 'workflows')).find(file => path.basename(file) === name)
  if (found == null)
    return null
  return { file: found, runId: path.basename(path.dirname(found)) }
}

function agentGauges({ agentTranscriptsUnder, readTranscript, SPEND_BASIS, spentOf, sumTranscripts }, root, transcript, config, caller) {
  const agent = agentFileOf(agentTranscriptsUnder, transcript, caller.agent_id)
  if (agent == null) {
    journal(root, { event: 'unread', hook: 'eddies-guard', reason: AGENT_TRANSCRIPT_MISSING, session_id: caller.session_id, agent_id: caller.agent_id })
    return []
  }
  const tokens = readTranscript(root, agent.file).tokens
  const gauges = [{ level: 'agent', key: caller.agent_id, name: 'spent', value: spentOf(tokens), limitName: 'agentSpend', limit: config.agentSpend, tokens, basis: SPEND_BASIS, action: AGENT_ACTION }]
  if (agent.runId != null) {
    const run = sumTranscripts(root, agentTranscriptsUnder(path.dirname(agent.file)))
    gauges.push({ level: 'run', key: agent.runId, runId: agent.runId, name: 'spent', value: spentOf(run), limitName: 'runSpend', limit: config.runSpend, tokens: run, basis: SPEND_BASIS, action: AGENT_ACTION })
  }
  return gauges
}

function crossesWarning(gauge, config) {
  return gauge.value >= gauge.limit * config.warnRatio
}

function measurementOf(gauge, caller) {
  return {
    level: gauge.level,
    spent: gauge.value,
    limit: gauge.limit,
    input_tokens: gauge.tokens.input,
    cache_creation_input_tokens: gauge.tokens.cacheWrite,
    cache_read_input_tokens: gauge.tokens.cacheRead,
    measurement_basis: gauge.basis,
    session_id: caller.session_id,
    agent_id: caller.agent_id,
    agent_type: caller.agent_type,
    run_id: gauge.runId ?? null,
  }
}

function warnOnce(root, gauge, caller, config) {
  const marker = path.join(root, WARNED_DIR, `${gauge.level}.${gauge.key}`)
  mkdirSync(path.dirname(marker), { recursive: true })
  try {
    writeFileSync(marker, '', { flag: 'wx' })
  }
  catch (error) {
    if (error.code === 'EEXIST')
      return null
    throw error
  }
  journal(root, { event: 'budget-warn', ...measurementOf(gauge, caller), warn_ratio: config.warnRatio })
  return warningOf(gauge, config)
}

function warningOf(gauge, config) {
  return `eddies: ${gauge.level} warn — ${gauge.name} ${Math.round(gauge.value)} / warn threshold ${Math.round(gauge.limit * config.warnRatio)} (limit ${gauge.limit}, ${gauge.limitName} in ${CONFIG_FILE}); ${WARN_ACTION}\n`
}

function measuredGauges(measure, root, input, config, caller) {
  const tool = input.tool_name
  const asAgent = caller.agent_id != null && tool !== RETURN_TOOL
  const asSession = caller.agent_id == null || isNewWork(input)
  if (!asSession && !asAgent)
    return []
  const transcript = transcriptOf(input)
  if (notCreatedYet(measure, root, transcript))
    return []
  return [
    ...(asSession ? sessionGauges(measure, root, transcript, config, caller) : []),
    ...(asAgent ? agentGauges(measure, root, transcript, config, caller) : []),
  ]
}

function stops(gauge, input) {
  return gauge.value >= gauge.limit && (gauge.level === 'agent' || gauge.level === 'run' || isNewWork(input))
}

function decide(measure, root, input, config) {
  const caller = callerOf(input)
  const warnings = []
  let stop = null
  for (const gauge of measuredGauges(measure, root, input, config, caller)) {
    const warning = crossesWarning(gauge, config) ? warnOnce(root, gauge, caller, config) : null
    if (warning != null)
      warnings.push(warning)
    if (stop == null && stops(gauge, input))
      stop = gauge
  }
  return { warnings, stop: stop == null ? null : { gauge: stop, caller } }
}

function stopLine({ gauge, caller }, tool) {
  return {
    event: 'budget-stop',
    reason: `${gauge.name} ${gauge.value} >= ${gauge.limitName} ${gauge.limit}`,
    tool: typeof tool === 'string' ? tool : null,
    ...measurementOf(gauge, caller),
  }
}

function refusalOf({ gauge }) {
  return `eddies: ${gauge.level} stop — ${gauge.name} ${gauge.value} / limit ${gauge.limit} (${gauge.limitName} in ${CONFIG_FILE}); ${gauge.action}\n`
}

function reasonOf(error) {
  if (error instanceof Unread)
    return error.message
  const code = error?.code
  return typeof code === 'string' && PLAIN_REASON.test(code) ? `transcript-${code}` : 'measure-error'
}

function recordUnread(root, input, hook, error) {
  try {
    const caller = callerOf(input)
    journal(root, { event: 'unread', hook, reason: reasonOf(error), session_id: caller.session_id, agent_id: caller.agent_id })
    return true
  }
  catch {
    return false
  }
}

function notCreatedYet({ hasBeenRead }, root, transcript) {
  return !existsSync(transcript) && !hasBeenRead(root, transcript)
}

function sessionWarnings(measure, root, input, config) {
  const caller = callerOf(input)
  const transcript = transcriptOf(input)
  if (notCreatedYet(measure, root, transcript))
    return []
  return sessionGauges(measure, root, transcript, config, caller)
    .filter(gauge => crossesWarning(gauge, config))
    .map(gauge => warnOnce(root, gauge, caller, config))
    .filter(warning => warning != null)
}

async function hookInput() {
  try {
    return parsedInput(await readInput())
  }
  catch {
    return null
  }
}

function refuse(line) {
  process.stderr.write(`${line}; refused — a guard that cannot measure lets nothing through\n`)
  process.exitCode = 2
}

async function run(hook, { act, failClosed }) {
  const input = await hookInput()
  if (input == null) {
    process.stderr.write('eddies: the hook input could not be read as a JSON object; refused\n')
    process.exitCode = 2
    return
  }
  let root = null
  try {
    root = projectRoot()
    if (root == null) {
      if (failClosed)
        refuse('eddies: CLAUDE_PROJECT_DIR is not a directory')
      else
        process.stderr.write('eddies: CLAUDE_PROJECT_DIR is not a directory; nothing measured\n')
      return
    }
    act(await import(MEASURE_MODULE), root, input, readConfig(root))
  }
  catch (error) {
    const recorded = root != null && recordUnread(root, input, hook, error)
    const line = `eddies: nothing measured (${reasonOf(error)})${recorded ? '' : ', and the line recording it was not written'}`
    if (failClosed)
      refuse(line)
    else if (!recorded)
      process.stderr.write(`${line}\n`)
  }
}

function guard(measure, root, input, config) {
  const { warnings, stop } = decide(measure, root, input, config)
  if (stop == null) {
    if (warnings.length > 0)
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warnings.join('') } }))
    return
  }
  process.exitCode = 2
  process.stderr.write(refusalOf(stop))
  journal(root, stopLine(stop, input.tool_name))
}

function prompt(measure, root, input, config) {
  process.stdout.write(sessionWarnings(measure, root, input, config).join(''))
}

const MODES = { guard: { act: guard, failClosed: true }, prompt: { act: prompt, failClosed: false } }

if (Object.hasOwn(MODES, process.argv[2]))
  void run(`eddies-${process.argv[2]}`, MODES[process.argv[2]])
