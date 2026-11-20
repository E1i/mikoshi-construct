import type { ShiftGate } from '../src/manifest.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shiftSettings } from '../scripts/ports/shift-settings.js'
import { allowRule, DAEMON_KEY, daemonProgram, declaredCommands, frontmatterFields, shippedDaemonCommands } from '../src/commands/attach/daemon-commands.js'
import { installHookEntries, readSettings, SETTINGS_FILE } from '../src/commands/attach/settings.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL_DIRECTORIES = ['.claude/skills', 'templates/ai/claude/_claude/skills']
const GATE: ShiftGate = { prepush: ['pnpm run quality'], handoffWrite: null, codeMatrix: null }
const scratches: string[] = []

afterEach(() => {
  for (const scratch of scratches.splice(0))
    rmSync(scratch, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  scratches.push(directory)
  return directory
}

interface DaemonSkill {
  file: string
  text: string
}

function daemonSkills(): DaemonSkill[] {
  return SKILL_DIRECTORIES.flatMap((directory) => {
    const skills = path.join(REPOSITORY_ROOT, directory)
    return readdirSync(skills).flatMap((skill) => {
      const file = path.join(skills, skill, 'SKILL.md')
      if (!existsSync(file))
        return []
      const text = readFileSync(file, 'utf8')
      const daemon = frontmatterFields(text).find(([key]) => key === DAEMON_KEY)?.[1]
      return daemon === undefined || daemon === '' ? [] : [{ file: path.join(directory, skill, 'SKILL.md'), text }]
    })
  })
}

interface Lists {
  allow: unknown[]
  excluded: unknown[]
}

function localLists(root: string): Lists {
  const settings = JSON.parse(readFileSync(path.join(root, SETTINGS_FILE), 'utf8')) as { permissions?: { allow?: unknown[] }, sandbox?: { excludedCommands?: unknown[] } }
  return { allow: settings.permissions?.allow ?? [], excluded: settings.sandbox?.excludedCommands ?? [] }
}

async function initialised(home: string): Promise<string> {
  const root = scratch('construct-daemon-grant-init-')
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' })
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir: root, preset: 'node-library', name: 'daemon-grant-fixture', yes: true, dryRun: false, home })
  return root
}

function attached(home: string): string {
  const root = scratch('construct-daemon-grant-attach-')
  const installed = installHookEntries(root, readSettings(root), home)
  expect(installed.kind).toBe('installed')
  return root
}

function installProgram(command: string): void {
  const program = daemonProgram(command)!
  mkdirSync(path.dirname(program), { recursive: true })
  writeFileSync(program, '')
}

describe('the law: installing a daemon grants its command', () => {
  it('every daemon skill declares its command and the install grants it in allow and excludedCommands', async () => {
    const home = scratch('construct-daemon-grant-home-')
    const skills = daemonSkills()
    expect(skills.map(skill => skill.file)).toContain('templates/ai/claude/_claude/skills/browser-lab/SKILL.md')
    const installs = { init: localLists(await initialised(home)), attach: localLists(attached(home)) }
    const tree = await initialised(home)
    for (const command of shippedDaemonCommands(home))
      installProgram(command)
    const card = shiftSettings(tree, GATE, [], home)
    for (const { file, text } of skills) {
      const commands = declaredCommands(text, home)
      expect(commands, file).not.toEqual([])
      for (const command of commands) {
        expect(command, file).not.toContain('<home>')
        expect(daemonProgram(command), file).not.toBeNull()
        for (const [install, lists] of Object.entries(installs)) {
          expect(lists.allow, `${file} · ${install}`).toContain(allowRule(command))
          expect(lists.excluded, `${file} · ${install}`).toContain(command)
        }
        expect(card.permissions.allow, `${file} · card`).toContain(allowRule(command))
        expect(card.sandbox.excludedCommands, `${file} · card`).toContain(command)
      }
    }
  })

  it('the install writes the grant only into the untracked local settings, never into the tracked project settings', async () => {
    const home = scratch('construct-daemon-grant-home-')
    const root = await initialised(home)
    const project = readFileSync(path.join(root, '.claude/settings.json'), 'utf8')
    for (const command of shippedDaemonCommands(home)) {
      expect(project).not.toContain(command)
      expect(project).not.toContain(home)
    }
  })

  it('reads the declared commands from the frontmatter of a daemon skill only, with the home written out', () => {
    expect(declaredCommands('---\ndaemon: LAB\ndaemon-command: node <home>/a.mjs *\ndaemon-command: node <home>/b.mjs *\n---\n', '/h')).toEqual(['node /h/a.mjs *', 'node /h/b.mjs *'])
    expect(declaredCommands('---\nname: plain\ndaemon-command: node <home>/a.mjs *\n---\n', '/h')).toEqual([])
    expect(declaredCommands('---\ndaemon: LAB\ndaemon-command:\n---\n', '/h')).toEqual([])
    expect(declaredCommands('daemon: LAB\ndaemon-command: node <home>/a.mjs *\n', '/h')).toEqual([])
    expect([daemonProgram('node /h/a.mjs *'), daemonProgram('node a.mjs *')]).toEqual(['/h/a.mjs', null])
    expect(allowRule('node /h/a.mjs *')).toBe('Bash(node /h/a.mjs *)')
  })
})
