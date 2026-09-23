import path from 'node:path'
import process from 'node:process'
import { isTTY } from '@clack/prompts'
import { defineCommand, runMain } from 'citty'
import { runAttach } from './commands/attach/index.js'
import { COST_EXIT, costJson, costReport, printCost } from './commands/cost/index.js'
import { printDoctor, runDoctor } from './commands/doctor/index.js'
import { modelPicture, printGraph, writeGraphPage } from './commands/graph.js'
import { runInit } from './commands/init.js'
import { printDetectReport } from './commands/soulkill.js'
import { applySync, printSync, printSyncApply, runSync, syncApplyExit, syncApplyJson, syncExit, syncJson } from './commands/sync/index.js'
import { detect } from './detect/index.js'
import { flatlineFor, reported } from './failure.js'
import { DEFAULT_REVIEW_MODEL, PRESET_IDS } from './presets/index.js'
import { createUi, stderrWriter, stdoutWriter } from './ui/console.js'

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

const init = defineCommand({
  meta: { name: 'init', description: 'Materialize the construct: architecture, contracts, harness, AI instructions' },
  args: {
    ...commonArgs,
    preset: { type: 'string', description: `Preset: ${PRESET_IDS.join(' | ')}` },
    ai: { type: 'string', description: 'AI target: claude | cursor | both (default: claude)' },
    name: { type: 'string', description: 'Project name (defaults to the directory name)' },
    review: { type: 'string', description: 'AI code review on pull requests: claude | none (default: none)' },
    reviewModel: { type: 'string', description: `Model for the review workflow (default: ${DEFAULT_REVIEW_MODEL})` },
    yes: { type: 'boolean', alias: 'y', description: 'Non-interactive: take defaults and skip the confirmation', default: false },
    dryRun: { type: 'boolean', description: 'Print the plan, write nothing', default: false },
  },
  async run({ args }) {
    const console = ui(args)
    console.banner(VERSION, args.johnny)
    try {
      const prompter = isTTY(process.stdout) && process.stdin.isTTY === true ? createClackPrompter(console.lore) : undefined
      const result = await runInit(console, { dir: args.dir, preset: args.preset, ai: args.ai, name: args.name, review: args.review, reviewModel: args.reviewModel, yes: args.yes, dryRun: args.dryRun }, prompter)
      process.exitCode = result.status === 'aborted' ? 1 : 0
    }
    catch (error) {
      flatlineFor(console, error)
      process.exitCode = 1
    }
  },
})

const attach = defineCommand({
  meta: { name: 'attach', description: 'Attach the /plan and /implement carriers to a repository the construct did not write, hidden through .git/info/exclude (alias: jack-in)' },
  args: {
    ...commonArgs,
    harness: { type: 'string', description: 'The harness command the ladder verifies with; nothing is assumed' },
    ai: { type: 'string', description: 'AI target: claude (cursor and both are refused)' },
    yes: { type: 'boolean', alias: 'y', description: 'Non-interactive: skip the confirmation; needs --harness', default: false },
  },
  async run({ args }) {
    const console = ui(args)
    console.banner(VERSION, args.johnny)
    try {
      const prompter = isTTY(process.stdout) && process.stdin.isTTY === true ? createClackPrompter(console.lore) : undefined
      const result = await runAttach(console, { dir: args.dir, harness: args.harness, ai: args.ai, yes: args.yes }, prompter)
      process.exitCode = result.status === 'done' ? 0 : 1
    }
    catch (error) {
      flatlineFor(console, error)
      process.exitCode = 1
    }
  },
})

const soulkill = defineCommand({
  meta: { name: 'soulkill', description: 'Extract the facts about a repository without writing anything (alias: inspect, capture)' },
  args: {
    ...commonArgs,
    json: { type: 'boolean', description: 'Machine-readable report', default: false },
  },
  run({ args }) {
    const report = detect(args.dir)
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return
    }
    const console = ui(args)
    console.banner(VERSION, args.johnny)
    console.soulkiller()
    console.line()
    printDetectReport(console, report)
  },
})

const doctor = defineCommand({
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
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        process.exitCode = result?.ok === true ? 0 : 1
        return
      }
      process.exitCode = printDoctor(console, result)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
})

const cost = defineCommand({
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
})

const graph = defineCommand({
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
})

const sync = defineCommand({
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
          process.stdout.write(`${JSON.stringify(result == null ? null : syncApplyJson(result), null, 2)}\n`)
          process.exitCode = syncApplyExit(result)
          return
        }
        process.exitCode = printSyncApply(console, result)
      }
      catch (error) {
        flatlineFor(console, error)
        process.exitCode = 1
      }
      return
    }

    const failed = reported(console, () => {
      const report = runSync(args.dir, VERSION)
      if (args.json) {
        process.stdout.write(`${JSON.stringify(report == null ? null : syncJson(report), null, 2)}\n`)
        process.exitCode = syncExit(report)
        return
      }
      process.exitCode = printSync(console, report)
    })
    if (failed !== 0)
      process.exitCode = failed
  },
})

const main = defineCommand({
  meta: {
    name: 'construct',
    version: VERSION,
    description: 'mikoshi-construct — bootstrap for AI-native software projects',
  },
  subCommands: {
    init,
    attach,
    'jack-in': attach,
    soulkill,
    'inspect': soulkill,
    'capture': soulkill,
    doctor,
    sync,
    cost,
    graph,
  },
})

runMain(main)
