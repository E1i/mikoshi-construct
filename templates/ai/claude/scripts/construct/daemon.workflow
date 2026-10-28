export const meta = {
  name: 'daemon',
  description: 'Run one fresh agent per object of a daemon adapter in a real browser lab, at most N at once, and record each object\'s evidence',
  phases: [
    { title: 'Objects', detail: 'daemon-run.mjs objects: the adapter checked, the extension built, the objects listed' },
    { title: 'Prepare', detail: 'daemon-run.mjs prepare: a lab copy of the extension and the adapter\'s prepare on it; a failed prepare is recorded unobserved and starts no agent' },
    { title: 'Observe', detail: 'a fresh agent per object with the adapter\'s mechanic prompt and the lab commands on a --profile-from copy of the base profile' },
    { title: 'Verdict', detail: 'daemon-run.mjs verdict: the adapter\'s success on the evidence directory, written to evidence.json' },
  ],
}

const DEFAULT_LIMIT = 2
const RUNNER = 'node scripts/construct/daemon-run.mjs'
const LAB = 'node scripts/construct/browser-lab.mjs'

const COMMAND_RESULT = {
  type: 'object',
  required: ['exitCode', 'stdout', 'stderr'],
  properties: {
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
}

const NO_ADAPTER_QUESTION = 'Pass args.adapter: the directory .construct/daemon/<name> whose adapter.json the run reads.'

const adapter = args.adapter
const { run: argRun } = args
const givenRun = typeof argRun === 'string' && argRun !== '' ? argRun : null
const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : DEFAULT_LIMIT
const baseProfile = typeof args.baseProfile === 'string' && args.baseProfile !== '' ? args.baseProfile : null
if (typeof adapter !== 'string' || adapter === '')
  return { status: 'blocked', question: NO_ADAPTER_QUESTION, objects: [] }

function commandPrompt(command) {
  return `Run exactly this one command from the repository root, once, and change nothing else:\n\n${command}\n\nReport its exit code, its stdout verbatim and its stderr verbatim.`
}

async function runCommand(command, options) {
  const result = await agent(commandPrompt(command), { effort: 'low', schema: COMMAND_RESULT, ...options })
  if (result == null)
    return null
  if (result.exitCode !== 0)
    return { ...result, value: null }
  try {
    return { ...result, value: JSON.parse(result.stdout) }
  }
  catch {
    return { ...result, value: null }
  }
}

function quoted(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

function agentLabel(run, object) {
  return `daemon:${run}:${object}`
}

function mechanicPrompt(listing, object, prepared) {
  const profile = baseProfile == null ? '' : ` --profile-from ${quoted(baseProfile)}`
  return [
    `You observe one object, ${object}, of the daemon adapter ${listing.adapter}, in a real browser. Read ${listing.mechanic} and do what it asks for this object; it is the adapter's prompt, and nothing in it widens what you may change.`,
    `The extension is the lab copy ${prepared.labCopy}, already prepared for this object. Use only the browser lab, from the repository root, and always on a fresh copy of the base profile:\n- ${LAB} <command> --extension ${quoted(prepared.labCopy)}${profile} …\n- ${LAB} hands --extension ${quoted(prepared.labCopy)}${profile} --evidence ${quoted(prepared.evidence)} -- -s ${quoted(object)} <playwright-cli arguments>, every one with -s ${quoted(object)}, your own hands session, ending with hands … -- -s ${quoted(object)} close`,
    `Write what you observed into ${prepared.evidence}/ and nowhere else: the JSON stdout of each lab command as lab-<n>.json, numbered from 1; a screenshot as shot.png (page … --shot ${prepared.evidence}/shot.png); the console of the hands session is written to console.json by the lab itself when you close it, so do not write it.`,
    'Edit no file of the repository and judge nothing: the adapter\'s success command gives the verdict from what you left in the evidence directory. End with one line naming what you observed.',
  ].join('\n\n')
}

function oneLine(text) {
  return String(text).split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

async function recordUnobserved(run, object, line, agentName, labCopy) {
  const text = oneLine(line)
  const agentOption = agentName == null ? '' : ` --agent ${quoted(agentName)}`
  const labOption = labCopy == null ? '' : ` --lab ${quoted(labCopy)}`
  const recorded = await runCommand(`${RUNNER} unobserved ${quoted(adapter)} ${quoted(run)} ${quoted(object)} --line ${quoted(text)}${agentOption}${labOption}`, { label: `unobserved:${object}`, phase: 'Verdict' })
  return recorded?.value ?? { object, verdict: 'unobserved', line: text, agent: agentName }
}

async function observe(listing, object) {
  const { run } = listing
  const prepared = await runCommand(`${RUNNER} prepare ${quoted(adapter)} ${quoted(run)} ${quoted(object)}`, { label: `prepare:${object}`, phase: 'Prepare' })
  if (prepared?.value == null)
    return recordUnobserved(run, object, prepared?.stderr || 'prepare did not report', null, null)
  if (prepared.value.prepared !== true)
    return { object, verdict: 'unobserved', line: prepared.value.line, agent: null }
  const label = agentLabel(run, object)
  const { labCopy } = prepared.value
  const observed = await agent(mechanicPrompt(listing, object, prepared.value), { label, phase: 'Observe' })
  if (observed == null)
    return recordUnobserved(run, object, 'the agent did not return', label, labCopy)
  const judged = await runCommand(`${RUNNER} verdict ${quoted(adapter)} ${quoted(run)} ${quoted(object)} --agent ${quoted(label)} --lab ${quoted(labCopy)}`, { label: `verdict:${object}`, phase: 'Verdict' })
  return judged?.value ?? recordUnobserved(run, object, judged?.stderr || 'verdict did not report', label, labCopy)
}

async function bounded(items, width, work) {
  const results = Array.from({ length: items.length })
  let next = 0
  async function lane() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane))
  return results
}

phase('Objects')
const runOption = givenRun == null ? '' : ` --run ${quoted(givenRun)}`
const listed = await runCommand(`${RUNNER} objects ${quoted(adapter)}${runOption}`, { label: 'objects', phase: 'Objects' })
if (listed?.value == null)
  return { status: 'refused', run: givenRun, line: listed?.stderr ?? 'objects did not report', objects: [] }
const listing = listed.value
const { run: listedRun } = listing
log(`${listing.objects.length} objects, at most ${limit} at once`)
const objects = await bounded(listing.objects, limit, object => observe(listing, object))
return {
  status: 'done',
  run: listedRun,
  evidence: `.construct/daemon/${listedRun}`,
  objects,
  unobserved: objects.filter(object => object.verdict === 'unobserved').map(object => object.object),
}
