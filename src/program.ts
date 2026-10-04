import type { ArgsDef, CommandDef, CommandMeta } from 'citty'
import type { BoardReading } from './commands/board/index.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { isTTY } from '@clack/prompts'
import { defineCommand, showUsage } from 'citty'
import { ATTACH_EXIT, printEntryProtocol, runAttach } from './commands/attach/index.js'
import { BOARD_EXIT, boardJson, printBoard, PRS_FROM_STDIN, readBoard, STALE_HOURS } from './commands/board/index.js'
import { COST_EXIT, costJson, costReport, printCost } from './commands/cost/index.js'
import { DETACH_EXIT, runDetach } from './commands/detach/index.js'
import { DOCTOR_EXIT, doctorJson, printDoctor, runDoctor } from './commands/doctor/index.js'
import { modelPicture, printGraph, writeGraphPage } from './commands/graph.js'
import { INIT_EXIT, runInit } from './commands/init.js'
import { defaultParking, printIntake, runIntake } from './commands/intake/index.js'
import { applyExit, applyJson, applyMutation, judgeExit, judgeJson, printApply, printJudge, REPORT_FORMATS, runJudge } from './commands/mutate/index.js'
import { printDetectReport, SOULKILL_EXIT, soulkillJson } from './commands/soulkill.js'
import { applySync, printSync, printSyncApply, runSync, SYNC_NO_MANIFEST_JSON, syncApplyExit, syncApplyJson, syncExit, syncJson } from './commands/sync/index.js'
import { detect } from './detect/index.js'
import { FAILED_EXIT, flatlineFor, reported } from './failure.js'
import { typedSpellings, unknownFlags } from './known-flags.js'
import { AI_TARGETS, DEFAULT_REVIEW_MODEL, PRESET_IDS, REVIEW_PROVIDERS } from './presets/index.js'
import { createUi, stderrWriter, stdoutWriter } from './ui/console.js'
import { LORE, PLAIN_LORE } from './ui/lore.js'

import { createClackPrompter } from './ui/prompts.js'
import { resolveTheme } from './ui/theme.js'
import { VERSION } from './version.js'

const commonArgs = {
  dir: { type: 'string', description: 'Target directory', default: '.' },
  plain: { type: 'boolean', description: 'No colors, no lore (CI-friendly)', default: false },
  johnny: { type: 'boolean', description: 'Wake up, Netrunner.', default: false },
} as const

function ui(args: { plain: boolean, johnny: boolean }, write = stdoutWriter) {
  return createUi(resolveTheme({ plain: args.plain, johnny: args.johnny }), write)
}

const ROOT_META = {
  name: 'construct',
  version: VERSION,
  description: 'mikoshi-construct — bootstrap for AI-native software projects',
}

const MUTATE_META = { name: 'mutate', description: 'Apply a named wrong implementation and judge it from the report the runner hands over; runs no test itself' }

function withKnownFlags<T extends ArgsDef>(def: CommandDef<T>, parentMeta: CommandMeta): CommandDef<T> {
  const { run, args } = def
  if (run == null || args == null || typeof args !== 'object')
    return def
  const argsDef = args as T
  const wrapped: CommandDef<T> = {
    ...def,
    run: async (context) => {
      const unknown = unknownFlags(argsDef, context.args as unknown as Record<string, unknown>)
      if (unknown.length === 0)
        return run(context)
      const plain = resolveTheme({ plain: context.args.plain as boolean | undefined, johnny: context.args.johnny as boolean | undefined }).name === 'plain'
      await showUsage(wrapped as CommandDef, { meta: parentMeta })
      console.error((plain ? PLAIN_LORE : LORE).unknownFlag(typedSpellings(unknown, context.rawArgs)))
      process.exitCode = FAILED_EXIT
    },
  }
  return wrapped
}

const init = withKnownFlags(defineCommand({
  meta: { name: 'init', description: 'Materialize the construct: architecture, contracts, harness, AI instructions' },
  args: {
    ...commonArgs,
    preset: { type: 'enum', options: PRESET_IDS, description: `Preset: ${PRESET_IDS.join(' | ')}` },
    ai: { type: 'enum', options: AI_TARGETS, description: 'AI target: claude | cursor | both (default: claude)' },
    name: { type: 'string', description: 'Project name (defaults to the directory name)' },
    review: { type: 'enum', options: REVIEW_PROVIDERS, description: 'AI code review on pull requests: claude | none (default: none)' },
    reviewModel: { type: 'string', description: `Model for the review workflow (default: ${DEFAULT_REVIEW_MODEL})` },
    harness: { type: 'string', description: 'The harness command the ladder verifies with; nothing is assumed' },
    yes: { type: 'boolean', alias: 'y', description: 'Non-interactive: take defaults and skip the confirmation', default: false },
    dryRun: { type: 'boolean', description: 'Print the plan, write nothing', default: false },
  },
  async run({ args }) {
    const console = ui(args)
    console.banner(VERSION, args.johnny)
    try {
      const prompter = isTTY(process.stdout) && process.stdin.isTTY === true ? createClackPrompter(console.lore) : undefined
      const result = await runInit(console, { dir: args.dir, preset: args.preset, ai: args.ai, name: args.name, review: args.review, reviewModel: args.reviewModel, harness: args.harness, yes: args.yes, dryRun: args.dryRun }, prompter)
      process.exitCode = INIT_EXIT[result.status]
    }
    catch (error) {
      flatlineFor(console, error)
      process.exitCode = FAILED_EXIT
    }
  },
}), ROOT_META)

const attach = withKnownFlags(defineCommand({
  meta: { name: 'attach', description: 'Attach the /plan and /implement carriers to a repository the construct did not write, hidden through .git/info/exclude (alias: jack-in)' },
  args: {
    ...commonArgs,
    harness: { type: 'string', description: 'The harness command the ladder verifies with; nothing is assumed' },
    ai: { type: 'enum', options: AI_TARGETS, description: 'AI target: claude (cursor and both are refused)' },
    yes: { type: 'boolean', alias: 'y', description: 'Non-interactive: skip the confirmation; needs --harness', default: false },
    entry: { type: 'boolean', description: 'Print the entry protocol the agent follows to propose one harness; reads and writes nothing', default: false },
  },
  async run({ args }) {
    const console = ui(args)
    console.banner(VERSION, args.johnny)
    try {
      if (args.entry) {
        printEntryProtocol(console)
        return
      }
      const prompter = isTTY(process.stdout) && process.stdin.isTTY === true ? createClackPrompter(console.lore) : undefined
      const result = await runAttach(console, { dir: args.dir, harness: args.harness, ai: args.ai, yes: args.yes }, prompter)
      process.exitCode = ATTACH_EXIT[result.status]
    }
    catch (error) {
      flatlineFor(console, error)
      process.exitCode = FAILED_EXIT
    }
  },
}), ROOT_META)

const detach = withKnownFlags(defineCommand({
  meta: { name: 'detach', description: 'Remove what attach wrote and nothing else: the recorded files, their empty directories, the exclude block and the record (alias: jack-out)' },
  args: commonArgs,
  run({ args }) {
    const console = ui(args)
    console.banner(VERSION, args.johnny)
    try {
      const result = runDetach(console, { dir: args.dir })
      process.exitCode = DETACH_EXIT[result.status]
    }
    catch (error) {
      flatlineFor(console, error)
      process.exitCode = FAILED_EXIT
    }
  },
}), ROOT_META)

const soulkill = withKnownFlags(defineCommand({
  meta: { name: 'soulkill', description: 'Extract the facts about a repository without writing anything (alias: inspect, capture)' },
  args: {
    ...commonArgs,
    json: { type: 'boolean', description: 'Machine-readable report', default: false },
  },
  run({ args }) {
    const report = detect(args.dir)
    process.exitCode = SOULKILL_EXIT.reported
    if (args.json) {
      process.stdout.write(`${JSON.stringify(soulkillJson(report), null, 2)}\n`)
      return
    }
    const console = ui(args)
    console.banner(VERSION, args.johnny)
    console.soulkiller()
    console.line()
    printDetectReport(console, report)
  },
}), ROOT_META)

const doctor = withKnownFlags(defineCommand({
  meta: { name: 'doctor', description: 'Check that the construct baseline and discovery are intact' },
  args: {
    ...commonArgs,
    json: { type: 'boolean', description: 'Machine-readable report', default: false },
  },
  run({ args }) {
    const console = ui(args, args.json ? stderrWriter : stdoutWriter)
    const failed = reported(console, () => {
      const result = runDoctor(args.dir)
      if (args.json) {
        process.stdout.write(`${JSON.stringify(doctorJson(result), null, 2)}\n`)
        process.exitCode = result == null ? DOCTOR_EXIT.noManifest : ('state' in result ? DOCTOR_EXIT.ok : (result.ok ? DOCTOR_EXIT.ok : DOCTOR_EXIT.notOk))
        return
      }
      process.exitCode = printDoctor(console, result)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
}), ROOT_META)

const CLEAR_SCREEN = '\u001B[2J\u001B[3J\u001B[H'

const board = withKnownFlags(defineCommand({
  meta: {
    name: 'board',
    description: 'Where each task stands, from the ladder runs in .construct/runs.jsonl and the pull request list that gh pr list wrote and --prs hands over; the CLI runs no gh and writes no file. Rows that wait for you are red; a row older than 4 hours is stale (--stale); a run finished or a pull request merged more than 12 hours ago is hidden unless --all',
  },
  args: {
    ...commonArgs,
    prs: { type: 'string', description: 'JSON file written by gh pr list, or - for stdin' },
    all: { type: 'boolean', description: 'Also show what is older than 12 hours, superseded or closed', default: false },
    stale: { type: 'string', description: 'Hours after which an open row is stale', default: String(STALE_HOURS) },
    every: { type: 'string', description: 'Redraw every <seconds>' },
    json: { type: 'boolean', description: 'Machine-readable board (format user-board/1)', default: false },
  },
  async run({ args }) {
    const console = ui(args, stderrWriter)
    const refuse = (message: string): void => {
      console.flatline(message)
      process.exitCode = FAILED_EXIT
    }
    const lore = console.lore
    const staleHours = Number(args.stale)
    const everySeconds = args.every === undefined ? undefined : Number(args.every)
    if (!(staleHours > 0))
      return refuse(lore.boardStaleInvalid)
    if (everySeconds !== undefined && !(Number.isInteger(everySeconds) && everySeconds >= 1))
      return refuse(lore.boardEveryInvalid)
    if (everySeconds !== undefined && args.json)
      return refuse(lore.boardEveryWithJson)
    if (everySeconds !== undefined && args.prs === PRS_FROM_STDIN)
      return refuse(lore.boardEveryWithStdin)
    const dir = path.resolve(args.dir)
    const frame = (): BoardReading => readBoard(dir, { all: args.all, staleHours, prs: args.prs, readStdin: () => readFileSync(0, 'utf8') })
    try {
      if (args.json) {
        process.stdout.write(`${JSON.stringify(boardJson(frame()), null, 2)}\n`)
        process.exitCode = BOARD_EXIT.shown
        return
      }
      const screen = ui(args)
      let again = true
      do {
        again = everySeconds !== undefined
        if (everySeconds !== undefined && screen.theme.name !== 'plain')
          process.stdout.write(CLEAR_SCREEN)
        process.exitCode = printBoard(screen, frame())
        if (everySeconds !== undefined)
          await new Promise(resolve => setTimeout(resolve, everySeconds * 1000))
      } while (again)
    }
    catch (error) {
      flatlineFor(console, error)
      process.exitCode = FAILED_EXIT
    }
  },
}), ROOT_META)

const cost = withKnownFlags(defineCommand({
  meta: { name: 'cost', description: 'Token usage of the /implement runs recorded for this directory (from Claude Code session data)' },
  args: {
    ...commonArgs,
    last: { type: 'boolean', description: 'Only the most recent run', default: false },
    json: { type: 'boolean', description: 'Machine-readable report', default: false },
  },
  run({ args }) {
    const console = ui(args, args.json ? stderrWriter : stdoutWriter)
    const failed = reported(console, () => {
      const report = costReport(path.resolve(args.dir))
      if (args.json) {
        process.stdout.write(`${JSON.stringify(costJson(report, args.last), null, 2)}\n`)
        process.exitCode = COST_EXIT[report.status]
        return
      }
      process.exitCode = printCost(console, report, args.last)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
}), ROOT_META)

const graph = withKnownFlags(defineCommand({
  meta: { name: 'graph', description: 'Draw what this repository claims, and the evidence under it, as a Mermaid diagram on stdout' },
  args: {
    ...commonArgs,
    out: { type: 'string', description: 'Also write one self-contained HTML file rendering the same graph' },
  },
  run({ args }) {
    const console = ui(args, stderrWriter)
    const failed = reported(console, () => {
      process.exitCode = printGraph(console, modelPicture(args.dir), stdoutWriter)
      if (args.out == null)
        return
      const written = writeGraphPage(args.dir, args.out)
      if (written != null)
        console.line(console.lore.graphPageWritten(written))
    })
    if (failed !== 0)
      process.exitCode = failed
  },
}), ROOT_META)

const sync = withKnownFlags(defineCommand({
  meta: { name: 'sync', description: 'Classify what today\'s construct would change in this repository; --apply writes what it owns' },
  args: {
    ...commonArgs,
    json: { type: 'boolean', description: 'Machine-readable report', default: false },
    apply: { type: 'boolean', description: 'Write the paths the construct owns \u2014 the only way sync writes; never a conflict, a removal or a merged file', default: false },
  },
  run({ args }) {
    const console = ui(args)
    if (args.apply) {
      try {
        const result = applySync(args.dir, VERSION)
        if (args.json) {
          process.stdout.write(`${JSON.stringify(result == null ? SYNC_NO_MANIFEST_JSON : syncApplyJson(result), null, 2)}\n`)
          process.exitCode = syncApplyExit(result)
          return
        }
        process.exitCode = printSyncApply(console, result)
      }
      catch (error) {
        flatlineFor(console, error)
        process.exitCode = FAILED_EXIT
      }
      return
    }

    const failed = reported(console, () => {
      const report = runSync(args.dir, VERSION)
      if (args.json) {
        process.stdout.write(`${JSON.stringify(report == null ? SYNC_NO_MANIFEST_JSON : syncJson(report), null, 2)}\n`)
        process.exitCode = syncExit(report)
        return
      }
      process.exitCode = printSync(console, report)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
}), ROOT_META)

const intake = withKnownFlags(defineCommand({
  meta: { name: 'intake', description: 'Turn a draft of sliced cards into parking cards: assigns the next numbers free in the parking and among the pull requests and issues --taken lists, marks what the retelling left unclear, and checks every card with the parking grammar before writing; the CLI runs no gh and no model' },
  args: {
    plain: commonArgs.plain,
    johnny: commonArgs.johnny,
    draft: { type: 'string', description: 'JSON file of the sliced cards ({ "cards": [ … ] }), or - for stdin' },
    taken: { type: 'string', description: 'File of the pull request and issue numbers already taken, whitespace-separated, or - for stdin' },
    parking: { type: 'string', description: 'The parking directory the cards are written to (default: ~/.construct/parking)' },
    dryRun: { type: 'boolean', description: 'Print the cards, write nothing', default: false },
  },
  run({ args }) {
    const console = ui(args)
    const failed = reported(console, () => {
      const result = runIntake({
        draft: args.draft,
        taken: args.taken,
        parking: path.resolve(args.parking ?? defaultParking()),
        dryRun: args.dryRun,
        readStdin: () => readFileSync(0, 'utf8'),
      })
      process.exitCode = printIntake(console, result)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
}), ROOT_META)

const mutateApply = withKnownFlags(defineCommand({
  meta: { name: 'apply', description: 'Apply one named wrong implementation from a brief: one find → replace in one file, with a copy and a record in .construct/mutations/' },
  args: {
    ...commonArgs,
    from: { type: 'string', description: 'The file carrying the mutation lines (M<id> | file | find: `old` → `new` | red: <test> | `message`)' },
    id: { type: 'string', description: 'The id of the mutation line to apply' },
    json: { type: 'boolean', description: 'Machine-readable report', default: false },
  },
  run({ args }) {
    const console = ui(args, args.json ? stderrWriter : stdoutWriter)
    const failed = reported(console, () => {
      const result = applyMutation({ dir: args.dir, from: args.from ?? '', id: args.id ?? '' })
      if (args.json) {
        process.stdout.write(`${JSON.stringify(applyJson(result), null, 2)}\n`)
        process.exitCode = applyExit(result)
        return
      }
      process.exitCode = printApply(console, result)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
}), MUTATE_META)

const mutateJudge = withKnownFlags(defineCommand({
  meta: { name: 'judge', description: 'Restore the mutated file from its copy and judge the outcome from a test report, or record a green report as the baseline' },
  args: {
    ...commonArgs,
    id: { type: 'string', description: 'The id of the applied mutation to restore and judge' },
    baseline: { type: 'boolean', description: 'Record a green report as the baseline apply requires', default: false },
    report: { type: 'string', description: 'The test report the runner wrote, in the format named by --format' },
    format: { type: 'enum', options: [...REPORT_FORMATS], description: 'The report format: vitest-json (the runner\'s json reporter) or junit-xml', default: 'vitest-json' },
    json: { type: 'boolean', description: 'Machine-readable report', default: false },
  },
  run({ args }) {
    const console = ui(args, args.json ? stderrWriter : stdoutWriter)
    const failed = reported(console, () => {
      const result = runJudge({ dir: args.dir, report: args.report, id: args.id, baseline: args.baseline, format: args.format })
      if (args.json) {
        process.stdout.write(`${JSON.stringify(judgeJson(result), null, 2)}\n`)
        process.exitCode = judgeExit(result)
        return
      }
      process.exitCode = printJudge(console, result)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
}), MUTATE_META)

const mutate = defineCommand({
  meta: MUTATE_META,
  subCommands: {
    apply: mutateApply,
    judge: mutateJudge,
  },
})

export const main = defineCommand({
  meta: ROOT_META,
  subCommands: {
    init,
    attach,
    'jack-in': attach,
    detach,
    'jack-out': detach,
    soulkill,
    'inspect': soulkill,
    'capture': soulkill,
    doctor,
    sync,
    cost,
    board,
    graph,
    intake,
    mutate,
  },
})
