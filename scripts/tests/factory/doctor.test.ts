import type { OperatorCommands } from '../../factory/doctor.js'
import type { Projection, StateDeps, StatePlaces } from '../../state/index.js'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTRACT, LOCAL_SETTINGS, operatorCommands, runDoctor } from '../../factory/doctor.js'
import { projectionPath, readView, runState, sealOf, stateFindings, statePlaces } from '../../state/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const RELEASE_PR = 812
const STATE_RULES = ['Bash(pnpm state:*)', 'Bash(pnpm state:note:*)', 'Bash(pnpm state:decision:*)', 'Bash(pnpm state:card:*)', 'Bash(pnpm state:handoff:*)']
const SHARED_SETTINGS = '{ "permissions": { "allow": ["Bash(git status)"] } }\n'
const EVERY_RULE = {
  permissions: {
    allow: ['Bash(git log:*)', 'Bash(pnpm shift:bg:*)', 'Bash(pnpm relaunch:bg:*)', 'Bash(gh pr merge:*)', 'Bash(ps:*)', 'Bash(pnpm miko:exit:*)', ...STATE_RULES],
    deny: [`Bash(gh pr merge ${RELEASE_PR}:*)`],
  },
  model: 'kept',
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function world(local: unknown): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'doctor-factory-'))
  roots.push(cwd)
  mkdirSync(path.join(cwd, 'contract'))
  mkdirSync(path.join(cwd, '.claude'))
  copyFileSync(path.join(REPO_ROOT, CONTRACT), path.join(cwd, CONTRACT))
  writeFileSync(path.join(cwd, '.claude', 'settings.json'), SHARED_SETTINGS)
  if (local !== undefined)
    writeFileSync(path.join(cwd, LOCAL_SETTINGS), `${JSON.stringify(local, null, 2)}\n`)
  return cwd
}

function gh(args: string[]): string {
  expect(args.slice(0, 2)).toEqual(['pr', 'list'])
  return JSON.stringify([{ number: 640, headRefName: 'feat/other' }, { number: RELEASE_PR, headRefName: 'changeset-release/main' }])
}

function without(rule: string, list: 'allow' | 'deny'): typeof EVERY_RULE {
  return { ...EVERY_RULE, permissions: { ...EVERY_RULE.permissions, [list]: EVERY_RULE.permissions[list].filter(kept => kept !== rule) } }
}

async function doctor(cwd: string, argv: string[] = [], options: { commands?: Partial<OperatorCommands>, confirm?: (() => Promise<boolean>) | null, state?: StatePlaces } = {}) {
  const commands = { window: [], role: [], ...options.commands }
  const state = options.state
  const result = await runDoctor(argv, { cwd, gh, commands: () => commands, state: () => state === undefined ? [] : stateFindings(state), confirm: options.confirm ?? null })
  expect(readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8')).toBe(SHARED_SETTINGS)
  return result
}

function stateWorld(): StatePlaces {
  const home = mkdtempSync(path.join(tmpdir(), 'doctor-state-'))
  roots.push(home)
  const places = statePlaces(home)
  mkdirSync(path.dirname(places.journal), { recursive: true })
  writeFileSync(places.decisions, '# Owner decisions\n\n- D-1 · 2026-10-01 — the first decision\n')
  writeFileSync(places.journal, '')
  return places
}

function stateDeps(places: StatePlaces): StateDeps {
  return { places, cwd: places.home, now: () => new Date('2026-10-10T08:00:00.000Z'), pid: process.pid, alive: () => false, out: () => {}, err: () => {} }
}

function local(cwd: string): string {
  return readFileSync(path.join(cwd, LOCAL_SETTINGS), 'utf8')
}

describe('pnpm doctor:factory', () => {
  it('prints nothing missing and exits 0 when settings.local.json holds every contract rule', async () => {
    const result = await doctor(world(EVERY_RULE))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).not.toContain('missing')
  })

  it('names a missing allow rule and exits 1', async () => {
    const result = await doctor(world(without('Bash(ps:*)', 'allow')))
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual(['[doctor:factory] missing allow Bash(ps:*)'])
  })

  it('names the missing deny for the open version pull request and exits 1', async () => {
    const result = await doctor(world(without(`Bash(gh pr merge ${RELEASE_PR}:*)`, 'deny')))
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual([`[doctor:factory] missing deny Bash(gh pr merge ${RELEASE_PR}:*)`])
    expect(result.stdout.join('\n')).not.toContain('640')
  })

  it('treats a missing settings.local.json as holding no rule', async () => {
    const result = await doctor(world(undefined))
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toHaveLength(11)
  })

  it('with --apply and a yes appends exactly the missing rules and keeps every rule already there', async () => {
    const partial = { permissions: { allow: ['Bash(git log:*)', 'Bash(gh pr merge:*)'], deny: ['Bash(rm:*)'] }, model: 'kept' }
    const cwd = world(partial)
    const result = await doctor(cwd, ['--apply'], { confirm: async () => true })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(local(cwd))).toEqual({
      permissions: {
        allow: ['Bash(git log:*)', 'Bash(gh pr merge:*)', 'Bash(pnpm shift:bg:*)', 'Bash(pnpm relaunch:bg:*)', 'Bash(ps:*)', 'Bash(pnpm miko:exit:*)', ...STATE_RULES],
        deny: ['Bash(rm:*)', `Bash(gh pr merge ${RELEASE_PR}:*)`],
      },
      model: 'kept',
    })
    expect((await doctor(cwd)).exitCode).toBe(0)
  })

  it('with --apply and a no, or with no terminal, leaves settings.local.json byte-identical', async () => {
    const cwd = world(without('Bash(ps:*)', 'allow'))
    const before = local(cwd)
    const refused = await doctor(cwd, ['--apply'], { confirm: async () => false })
    expect(refused.exitCode).toBe(1)
    expect(refused.stdout).toContain('[doctor:factory] missing allow Bash(ps:*)')
    expect(local(cwd)).toBe(before)
    expect((await doctor(cwd, ['--apply'], { confirm: null })).exitCode).toBe(1)
    expect(local(cwd)).toBe(before)
  })

  it('with --apply and no terminal creates no settings.local.json', async () => {
    const cwd = world(undefined)
    await doctor(cwd, ['--apply'], { confirm: null })
    expect(existsSync(path.join(cwd, LOCAL_SETTINGS))).toBe(false)
  })

  it('names a command with an env prefix that matches no Bash(gh pr merge:*) rule and exits 1', async () => {
    const result = await doctor(world(EVERY_RULE), [], { commands: { window: ['GH_TOKEN=x gh pr merge 1 --squash'] } })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual(['[doctor:factory] command `GH_TOKEN=x gh pr merge 1 --squash` does not have the shape of Bash(gh pr merge:*)'])
  })

  it('passes a window command that starts with the rule prefix and ignores window commands no rule names', async () => {
    const result = await doctor(world(EVERY_RULE), [], { commands: { window: ['gh pr merge 1 --squash', 'gh -R E1i/x pr merge 1', 'pnpm board', 'git push https://x'] } })
    expect(result.exitCode).toBe(0)
  })

  it('finds every window command in the shape of a contract rule', async () => {
    const { window } = operatorCommands(REPO_ROOT)
    expect(window.some(command => command.startsWith('gh pr merge'))).toBe(true)
    expect(window.some(command => command.startsWith('pnpm relaunch:bg'))).toBe(true)
    expect((await doctor(world(EVERY_RULE), [], { commands: { window } })).exitCode).toBe(0)
  })

  it('names a role command no rule allows and exits 1', async () => {
    const real = await doctor(world(EVERY_RULE), [], { commands: operatorCommands(REPO_ROOT) })
    expect(real.exitCode).toBe(0)
    expect(real.stdout.filter(line => line.includes('is allowed by no rule'))).toEqual([])
    const allowed = await doctor(world(EVERY_RULE), [], { commands: { role: ['gh -R E1i/x pr merge 1', 'gh --repo E1i/x pr merge 1 --squash', 'pnpm shift:bg x'] } })
    expect(allowed.exitCode).toBe(0)
    const named = await doctor(world(EVERY_RULE), [], { commands: { role: ['gh -R E1i/x pr view 1'] } })
    expect(named.exitCode).toBe(1)
    expect(named.stdout).toEqual([`[doctor:factory] command \`gh -R E1i/x pr view 1\` is allowed by no rule in ${CONTRACT}`])
  })

  it('write bypassing state: names a state file changed with no state:* event after its last one, and exits 1', async () => {
    const places = stateWorld()
    expect(runState(['decision', 'through', 'the', 'command'], stateDeps(places))).toBe(0)
    const passed = await doctor(world(EVERY_RULE), [], { state: places })
    expect(passed.exitCode).toBe(0)
    writeFileSync(places.decisions, `${readFileSync(places.decisions, 'utf8')}- D-3 · 2026-10-10 — appended by hand\n`)
    const named = await doctor(world(EVERY_RULE), [], { state: places })
    expect(named.exitCode).toBe(1)
    expect(named.stdout).toEqual([`[doctor:factory] state: ${places.decisions}: changed with no state:* event since the decision at 2026-10-10T08:00:00.000Z`])
  })

  it('write bypassing state: names a stored projection that differs from the one rebuilt from scratch, and exits 1', async () => {
    const places = stateWorld()
    readView('decisions', places)
    const file = projectionPath('decisions', places)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Projection
    const forged = { ...stored, lines: ['- D-9 · 2026-10-10 — never decided'] }
    writeFileSync(file, JSON.stringify({ ...forged, seal: sealOf(forged) }))
    const named = await doctor(world(EVERY_RULE), [], { state: places })
    expect(named.exitCode).toBe(1)
    expect(named.stdout).toEqual([`[doctor:factory] state: ${file}: differs from the decisions view rebuilt from its source`])
  })

  it('refuses an unknown argument', async () => {
    expect((await doctor(world(EVERY_RULE), ['--force'])).exitCode).toBe(2)
  })
})
