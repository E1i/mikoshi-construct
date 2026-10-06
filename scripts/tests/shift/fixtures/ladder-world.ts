import type { PnpmResult, ShiftDeps } from '../../../shift/shift.js'
import type { Captured, FakeGh, World } from './autopilot-world.js'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { approvalSha256, approvedHashPath, canonicalImplementText } from '../../../ghosts/approval.js'
import { depsOf } from './autopilot-world.js'

export const LADDER = 'implement/runner/M/ladder/owner'
export const BRIEF_TEXT = '/implement stub brief\nSketch: none — stub\n'
const STUB = path.join(import.meta.dirname, 'claude-stub-ladder.sh')

export type Launch = 'done' | 'running' | 'exit' | { ladder: string }
export type Morse = 'approves' | 'refuses'

export interface PnpmCall {
  args: string[]
  input: string | undefined
}

export interface Ladder {
  calls: PnpmCall[]
  pnpm: (cwd: string, args: string[], input?: string) => PnpmResult
}

export function cardNameOf(id: number): string {
  return `task-${id}`
}

export function briefOf(world: World, id: number): string {
  return path.join(world.handoff, `brief-${id}-${cardNameOf(id)}.md`)
}

export function briefSha256(): string {
  return approvalSha256(canonicalImplementText(BRIEF_TEXT)!)
}

export function approve(world: World, id: number): void {
  const brief = briefOf(world, id)
  writeFileSync(brief, BRIEF_TEXT)
  writeFileSync(approvedHashPath(brief), `approved /implement text sha256: ${briefSha256()} sketch: none (2026-10-06, owner)\n`)
}

function launchLines(world: World, id: number, launch: Launch): string[] {
  const entry = { event: 'entry', task: cardNameOf(id), CONTRACT: `ladder · brief ${path.basename(briefOf(world, id))} approved ${briefSha256().slice(0, 7)} · law brief Acceptance:`, ts: 'x' }
  const ended = { event: 'task', task: cardNameOf(id), approvedSha256: briefSha256(), ladder: typeof launch === 'string' ? 'done' : launch.ladder, ts: 'y' }
  return launch === 'running' || launch === 'exit' ? [JSON.stringify(entry)] : [JSON.stringify(entry), JSON.stringify(ended)]
}

export function ladderPnpm(world: World, id: number, behaviour: { morse?: Morse, launch?: Launch, ghostWrites?: boolean } = {}): Ladder {
  const calls: PnpmCall[] = []
  const pnpm = (_cwd: string, args: string[], input?: string): PnpmResult => {
    calls.push({ args, input })
    if (args[0] === 'ghosts:hash') {
      if (behaviour.morse === 'refuses')
        return { code: 1, stdout: '', stderr: `the brief waits for the owner: card #${id} is R1 (it touches the runner)\nsecond line\n` }
      writeFileSync(approvedHashPath(briefOf(world, id)), `approved /implement text sha256: ${briefSha256()} sketch: none (2026-10-06, morse)\n`)
      return { code: 0, stdout: 'approved\n', stderr: '' }
    }
    const launch = behaviour.launch ?? 'done'
    if (behaviour.ghostWrites === true)
      writeFileSync(path.join(world.root, `mc-${id}`, 'ghost-output.txt'), 'the Ghost wrote this\n')
    appendFileSync(world.journal, launchLines(world, id, launch).map(line => `${line}\n`).join(''))
    return launch === 'exit' ? { code: 1, stdout: '', stderr: `task ${cardNameOf(id)}: refused by the launcher\nsecond line\n` } : { code: typeof launch === 'object' ? 1 : 0, stdout: '', stderr: '' }
  }
  return { calls, pnpm }
}

export function ladderDeps(world: World, gh: FakeGh['gh'], io: Captured, ladder: Ladder, extra: Partial<ShiftDeps> = {}): ShiftDeps {
  return depsOf(world, gh, io, { claude: `STUB_OUT=${world.stubOut} CONSTRUCT_HANDOFF_DIR=${world.handoff} sh ${STUB}`, pnpm: ladder.pnpm, ...extra })
}

export function briefWritten(world: World, id: number): boolean {
  return existsSync(briefOf(world, id)) && readFileSync(briefOf(world, id), 'utf8') === BRIEF_TEXT
}
