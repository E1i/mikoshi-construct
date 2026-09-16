import path from 'node:path'
import process from 'node:process'
import { isTTY } from '@clack/prompts'
import { defineCommand, runMain } from 'citty'
import { collectWorkflowRuns, printCost } from './commands/cost.js'
import { printDoctor, runDoctor } from './commands/doctor.js'
import { runInit } from './commands/init.js'
import { printDetectReport } from './commands/soulkill.js'
import { detect } from './detect/index.js'
import { DEFAULT_REVIEW_MODEL, PRESET_IDS } from './presets/index.js'
import { createUi } from './ui/console.js'
import { createClackPrompter } from './ui/prompts.js'
import { resolveTheme } from './ui/theme.js'
import { VERSION } from './version.js'

const commonArgs = {
  dir: { type: 'string', description: 'Target directory', default: '.' },
  plain: { type: 'boolean', description: 'No colors, no lore (CI-friendly)', default: false },
  johnny: { type: 'boolean', description: 'Wake up, Netrunner.', default: false },
} as const

function ui(args: { plain: boolean, johnny: boolean }) {
  return createUi(resolveTheme({ plain: args.plain, johnny: args.johnny }))
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
      console.flatline(error instanceof Error ? error.message : String(error))
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
    const result = runDoctor(args.dir)
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exitCode = result?.ok === true ? 0 : 1
      return
    }
    const console = ui(args)
    process.exitCode = printDoctor(console, result)
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
    const runs = collectWorkflowRuns(path.resolve(args.dir))
    if (args.json) {
      const selected = runs == null ? null : args.last ? runs.slice(-1) : runs
      process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`)
      process.exitCode = runs == null ? 1 : 0
      return
    }
    const console = ui(args)
    process.exitCode = printCost(console, runs, args.last)
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
    soulkill,
    inspect: soulkill,
    capture: soulkill,
    doctor,
    cost,
  },
})

runMain(main)
