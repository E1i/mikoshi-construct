import type { AdmitOptions, AdmitResult } from '../src/commands/intake/admit.js'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { riskOf } from '../src/card/risk.js'
import { printAdmit, runAdmit } from '../src/commands/intake/admit.js'
import { NO_OWNER_PATH, OWNER_MERGES, ownerPathsOf } from '../src/commands/intake/check.js'
import { INTAKE_EXIT } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-09T09:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, journal: string, repo: string }

function world(files: readonly string[], ownerMerges = true): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-decision-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), '')
  }
  if (ownerMerges) {
    mkdirSync(path.join(repo, 'architecture'), { recursive: true })
    copyFileSync(OWNER_MERGES, path.join(repo, OWNER_MERGES))
  }
  return { parking: path.join(root, 'parking'), journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo }
}

function park(w: World, id: number, decision: string, touches: string): string {
  mkdirSync(w.parking, { recursive: true })
  const file = path.join(w.parking, `${id}.md`)
  writeFileSync(file, `card: #${id} card-${id} [implement/runner/S/cheap/${decision}] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
  return file
}

function admit(w: World, file: string, options: Partial<AdmitOptions> = {}): AdmitResult {
  return runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, ...options }, () => NOW)
}

function cardOf(file: string): string {
  return readFileSync(file, 'utf8').split('\n')[0]!
}

describe('construct intake --admit derives the decision from architecture/owner-merges.md', () => {
  it('touches with no owner path make the card auto', () => {
    const w = world(['src/board/run.ts'])
    const file = park(w, 80, 'owner', 'src/board/**')
    const result = admit(w, file, { autoConfirm: true })
    expect(result.status).toBe('admitted')
    expect(cardOf(file)).toBe('card: #80 card-80 [implement/runner/S/cheap/auto] · depends — · blocks —')
  })

  it('a touch under .claude/skills makes the card owner', () => {
    const w = world(['.claude/skills/intake/SKILL.md'])
    const file = park(w, 81, 'auto', '.claude/skills/intake/SKILL.md')
    const result = admit(w, file, { autoConfirm: true })
    expect(result.status).toBe('admitted')
    expect(cardOf(file)).toBe('card: #81 card-81 [implement/runner/S/cheap/owner] · depends — · blocks —')
    expect(readFileSync(file, 'utf8')).toContain('corrected: decision — auto → owner — .claude/skills/intake/SKILL.md meets .claude/skills/** of architecture/owner-merges.md')
  })

  it('a prefix touch over an owner glob makes the card owner', () => {
    const w = world(['.claude/skills/intake/SKILL.md'])
    const file = park(w, 82, 'auto', '.claude/**')
    expect(admit(w, file, { autoConfirm: true }).status).toBe('admitted')
    expect(cardOf(file)).toContain('/owner]')
  })

  it('a hand-written owner decision with no owner path is refused, naming it', () => {
    const w = world(['src/board/run.ts'])
    const file = park(w, 83, 'owner', 'src/board/**')
    const before = readFileSync(file, 'utf8')
    const result = admit(w, file)
    expect(result.status).toBe('refused')
    expect(result.status === 'refused' && result.why).toContain(`decision owner, but ${NO_OWNER_PATH}`)
    const lines: string[] = []
    expect(printAdmit(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)).toBe(INTAKE_EXIT.refused)
    expect(lines.join('\n')).toContain(NO_OWNER_PATH)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(w.journal)).toBe(false)
  })

  it('the token the refusal names admits the card as auto', () => {
    const w = world(['src/board/run.ts'])
    const file = park(w, 84, 'owner', 'src/board/**')
    const refused = admit(w, file)
    const token = refused.status === 'refused' ? /--confirm (\w+)/.exec(refused.why)?.[1] : undefined
    expect(admit(w, file, { confirm: token }).status).toBe('admitted')
    expect(cardOf(file)).toContain('/auto]')
  })

  it('an R1 card on the approval rules is owner by its owner-merges row', () => {
    const w = world(['scripts/ghosts/approve.ts'])
    expect(riskOf('scripts/ghosts/approve.ts').level).toBe('R1')
    const file = park(w, 85, 'auto', 'scripts/ghosts/approve.ts')
    expect(admit(w, file, { autoConfirm: true }).status).toBe('admitted')
    expect(cardOf(file)).toContain('/owner]')
    expect(readFileSync(file, 'utf8')).toContain('scripts/ghosts/approve.ts meets scripts/ghosts/approve.ts of architecture/owner-merges.md, owner by risk R1')
  })

  it('every approval-rules path is R1', () => {
    const { byRisk } = ownerPathsOf(readFileSync(OWNER_MERGES, 'utf8'))
    const globs = byRisk.filter(row => row.level === 'R1').flatMap(row => row.globs)
    expect(globs).toContain('scripts/ghosts/approve.ts')
    expect(globs.filter(glob => riskOf(glob).level !== 'R1')).toEqual([])
  })

  it('an approval-rules path is no merge kind, so a pull request on it is not owner-merged by its path', () => {
    const { globs } = ownerPathsOf(readFileSync(OWNER_MERGES, 'utf8'))
    expect(globs.filter(glob => glob.startsWith('scripts/ghosts/'))).toEqual([])
  })

  it('in a repository with no owner-merges.md the card\'s decision stands', () => {
    const w = world(['src/board/run.ts'], false)
    const file = park(w, 86, 'owner', 'src/board/**')
    expect(admit(w, file).status).toBe('admitted')
    expect(cardOf(file)).toContain('/owner]')
  })
})
