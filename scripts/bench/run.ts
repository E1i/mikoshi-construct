import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Anthropic from '@anthropic-ai/sdk'
import { captureOnce, EFFORT, MODEL } from './capture.js'
import { corpus } from './corpus.js'
import { summarize, verdictOf } from './report.js'

const DEFAULT_OUT = 'bench/architect-capture.jsonl'

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? null : process.argv[at + 1] ?? ''
}

function plan(): { rounds: number, out: string, confirmed: boolean } {
  const rounds = Number(flag('rounds') ?? 1)
  return {
    rounds: Number.isInteger(rounds) && rounds > 0 ? rounds : 1,
    out: flag('out') ?? DEFAULT_OUT,
    confirmed: process.argv.includes('--yes'),
  }
}

async function main(): Promise<void> {
  const { rounds, out, confirmed } = plan()
  const briefs = corpus()
  const invocations = briefs.length * rounds

  console.log('This run is diagnostic, not acceptance. It names what the design step emits and why the')
  console.log('runtime does or does not accept it. It does not establish a rate for a fix, and no result')
  console.log('from it may be reported as one — a rate is measured after a fix, against the cause this names.')
  console.log('')
  console.log('What counts is a usable design, not a payload that parses. Parsing is reported beside it,')
  console.log('never in place of it: a design the ladder accepts can still be the word "test".')
  console.log('')
  console.log('This path holds the raw bytes and gives the architect no tools, so it explores no tree and')
  console.log('costs little. It is therefore NOT the ladder\'s transport — scripts/bench/architect-capture')
  console.log('.workflow.mjs is, and it is the one whose result may be read as being about the ladder.')
  console.log('')
  console.log(`${invocations} invocations of ${MODEL} at effort ${EFFORT}: ${briefs.length} briefs x ${rounds} rounds.`)
  console.log(`Every payload is written whole to ${out}, with no cap.`)

  if (!confirmed) {
    console.log('')
    console.log('This spends real money. Re-run with --yes to start.')
    return
  }

  mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  writeFileSync(out, '')

  const client = new Anthropic()
  const captures = []
  for (let round = 1; round <= rounds; round++) {
    for (const brief of briefs) {
      const capture = await captureOnce(client, brief, round)
      captures.push(capture)
      appendFileSync(out, `${JSON.stringify(capture)}\n`)
      const { bytes, failure, failureOffset, characterAtFailure, controlCharacters } = capture.facts
      const verdict = verdictOf(capture)
      const outcome = verdict.usable
        ? 'usable design'
        : verdict.parses
          ? `parsed but unusable — ${verdict.shortfalls.join('; ')}`
          : `${failure} at ${failureOffset} (${JSON.stringify(characterAtFailure)})`
      const controls = controlCharacters.length === 0 ? '' : `, ${controlCharacters.length} control chars (${controlCharacters[0].name} at ${controlCharacters[0].offset})`
      console.log(`  ${brief.name} attempt ${round}: ${bytes} bytes, stop ${capture.stopReason ?? 'unrecorded'}${controls} — ${outcome}`)
    }
  }

  console.log('')
  console.log(JSON.stringify(summarize(captures), null, 2))
}

await main()
