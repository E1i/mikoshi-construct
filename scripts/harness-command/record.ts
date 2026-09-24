import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { convertedDigests, PNPM_HARNESS, PNPM_OUTPUT_FIXTURE } from './render.js'

writeFileSync(PNPM_OUTPUT_FIXTURE, `${JSON.stringify(convertedDigests(PNPM_HARNESS), null, 2)}\n`)
console.warn(`[harness-command] ${path.relative(process.cwd(), PNPM_OUTPUT_FIXTURE)}`)
