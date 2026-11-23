import type { ShiftGate } from '../../../src/manifest.js'
import type { CardGrant } from '../../ports/card-grants.js'
import type { ShiftSettings } from '../../ports/shift-settings.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowRule, shippedDaemonCommands } from '../../../src/commands/attach/daemon-commands.js'
import { browserLabExcludedCommand, browserLabInstalledScript } from '../../../src/commands/attach/settings.js'
import { runInit } from '../../../src/commands/init.js'
import { readManifest, readShiftGate } from '../../../src/manifest.js'
import { createUi, silentWriter } from '../../../src/ui/console.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { treeReportPath } from '../../core/places.js'
import { CARD_GRANTS, cardOfTree, GRANT_SCRATCH_DIRECTORY, GRANT_SCRATCH_SPELLINGS, grantOf } from '../../ports/card-grants.js'
import { CARD_SESSION_SANDBOX, SESSION_BASH_CAP, settingsFlag, shiftSettings } from '../../ports/shift-settings.js'
import { WIDE_VITEST_HOOKS } from '../../ports/wide-vitest-guard.js'

const plantedGrants = vi.hoisted(() => ({ rows: [] as CardGrant[] }))

vi.mock('../../ports/card-grants.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ports/card-grants.js')>()
  return { ...original, grantOf: (card: number | null) => original.grantOf(card, [...original.CARD_GRANTS, ...plantedGrants.rows]) }
})

function editCovers(rule: string, file: string): boolean {
  const pattern = /^Edit\(\/(.+)\)$/.exec(rule)?.[1]
  if (pattern === undefined)
    return false
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern
}

describe('the settings a card session is started with in a repository after construct init --preset node-library', () => {
  let tree = ''

  beforeAll(async () => {
    tree = mkdtempSync(path.join(tmpdir(), 'construct-shift-settings-'))
    await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir: tree, preset: 'node-library', name: 'shift-settings-fixture', yes: true, dryRun: false })
  })

  afterAll(() => rmSync(tree, { recursive: true, force: true }))

  it('keep the sandbox on with no way to start without it or to run a command outside it', () => {
    expect(shiftSettings(tree, readShiftGate(tree), [], tree).sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
  })

  it('bus sessions may listen on the tsx pipe and no other socket', () => {
    const uid = userInfo().uid
    expect(shiftSettings(tree, readShiftGate(tree), [], tree).sandbox.network).toEqual({ allowLocalBinding: true, allowUnixSockets: [`/tmp/claude-${uid}/tsx-${uid}`], allowMachLookup: ['com.apple.trustd*'] })
  })

  it('card sessions may look up trustd so gh verifies TLS, and no host is added', () => {
    const cardWithNoGrantsRow = 2177
    expect(grantOf(cardWithNoGrantsRow)).toBeNull()
    const { network } = shiftSettings(tree, readShiftGate(tree), [], tree, cardWithNoGrantsRow).sandbox
    expect(network.allowMachLookup).toEqual(['com.apple.trustd*'])
    expect(network).not.toHaveProperty('allowedDomains')
  })

  it('allow exactly the gate commands of the tree\'s construct config and edits inside the card tree, and no other rule', () => {
    const command = readManifest(tree)!.harness.command
    expect(shiftSettings(tree, readShiftGate(tree), [], tree).permissions).toEqual({ allow: [`Bash(${command})`, `Edit(/${tree}/**)`] })
  })

  it('cover the tree report and a file inside the tree, and nothing beside the tree', () => {
    const { allow } = shiftSettings(tree, readShiftGate(tree)).permissions
    const covered = (file: string): boolean => allow.some(rule => editCovers(rule, file))
    expect([treeReportPath(tree), path.join(tree, 'src', 'index.ts'), `${tree}-beside/x`, path.join(path.dirname(tree), 'canary')].map(covered)).toEqual([true, true, false, false])
  })

  it('allow an edit outside the tree only on a file the starter names', () => {
    const question = path.join(tmpdir(), 'answers', 'owner-question.md')
    expect(shiftSettings(tree, readShiftGate(tree), [question]).permissions.allow.at(-1)).toBe(`Edit(/${question})`)
  })

  it('travel as one --settings argument holding the settings as JSON, behind --setting-sources that leaves out the user settings', () => {
    const settings = shiftSettings(tree, readShiftGate(tree))
    const [sourcesFlag, sources, flag, json] = settingsFlag(settings)
    expect({ sourcesFlag, sources, flag, settings: JSON.parse(json!) }).toEqual({ sourcesFlag: '--setting-sources', sources: 'project,local', flag: '--settings', settings })
  })
})

describe('the browser lab exclusion a card session takes from the settings of its repository', () => {
  const OTHER_ENTRY = 'bash *'
  const RELATIVE_ENTRY = 'node scripts/construct/browser-lab.mjs *'
  const GATE: ShiftGate = { prepush: ['pnpm run quality'], handoffWrite: null, codeMatrix: null }
  let tree = ''
  let home = ''
  let entry = ''

  beforeEach(() => {
    tree = mkdtempSync(path.join(tmpdir(), 'construct-shift-lab-'))
    home = mkdtempSync(path.join(tmpdir(), 'construct-shift-home-'))
    entry = browserLabExcludedCommand(home)
    mkdirSync(path.join(tree, '.claude'))
    mkdirSync(path.dirname(browserLabInstalledScript(home)), { recursive: true })
    writeFileSync(browserLabInstalledScript(home), '')
  })

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  function holdSettings(file: string, excludedCommands: unknown): void {
    writeFileSync(path.join(tree, '.claude', file), JSON.stringify({ sandbox: { excludedCommands } }))
  }

  function settings(): ShiftSettings {
    return shiftSettings(tree, GATE, [], home)
  }

  function excludedBy(pattern: string, call: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(call)
  }

  const SETTINGS_FILES = ['settings.json', 'settings.local.json']

  it('a repository that excludes the lab in settings.json or settings.local.json gets exactly that one entry', () => {
    const excluded = SETTINGS_FILES.map((file) => {
      holdSettings(file, [entry])
      const { excludedCommands } = settings().sandbox
      rmSync(path.join(tree, '.claude', file))
      return excludedCommands
    })
    expect(excluded).toEqual([[entry], [entry]])
  })

  it('any other entry the repository excludes never reaches the session settings', () => {
    holdSettings('settings.json', [OTHER_ENTRY, entry])
    holdSettings('settings.local.json', [OTHER_ENTRY])
    const together = settings().sandbox.excludedCommands
    holdSettings('settings.json', [OTHER_ENTRY])
    expect({ together, alone: settings().sandbox.excludedCommands }).toEqual({ together: [entry], alone: undefined })
  })

  it('the excluded command names the absolute lab script outside the tree and no copy in the tree', () => {
    holdSettings('settings.json', [RELATIVE_ENTRY])
    const relative = settings()
    holdSettings('settings.json', [entry])
    const absolute = settings()
    rmSync(browserLabInstalledScript(home))
    const notInstalled = settings()
    expect(entry).toBe(`node ${home}/.construct/browser-lab/bin/browser-lab.mjs *`)
    expect(path.isAbsolute(browserLabInstalledScript(home))).toBe(true)
    expect(browserLabInstalledScript(home).startsWith(`${tree}${path.sep}`)).toBe(false)
    expect({ relative: relative.sandbox.excludedCommands, absolute: absolute.sandbox.excludedCommands, notInstalled: notInstalled.sandbox.excludedCommands }).toEqual({ relative: undefined, absolute: [entry], notInstalled: undefined })
    expect(excludedBy(entry, `node ${browserLabInstalledScript(home)} page about:blank`)).toBe(true)
    for (const call of ['node scripts/construct/browser-lab.mjs page about:blank', `node ${tree}/scripts/construct/browser-lab.mjs page about:blank`, `node ${tree}/sub/scripts/construct/browser-lab.mjs page about:blank`, 'node sub/scripts/construct/browser-lab.mjs page about:blank'])
      expect(excludedBy(entry, call), call).toBe(false)
  })

  it('a session excluded for the lab may not rewrite the lab', () => {
    const lab = path.join(tree, 'scripts', 'construct', 'browser-lab.mjs')
    const without = settings()
    holdSettings('settings.local.json', [entry])
    const excluded = settings()
    expect(excluded.permissions.deny).toContain(`Edit(/${lab})`)
    expect(excluded.sandbox.filesystem?.denyWrite).toContain(lab)
    expect({ deny: without.permissions.deny, filesystem: without.sandbox.filesystem }).toEqual({ deny: undefined, filesystem: undefined })
  })

  it('a session excluded for the lab may not write the lab cache', () => {
    const labHome = path.join(home, '.construct', 'browser-lab')
    const without = settings()
    holdSettings('settings.json', [entry])
    const excluded = settings()
    expect(excluded.permissions.deny).toContain(`Edit(/${labHome}/**)`)
    expect(excluded.sandbox.filesystem?.denyWrite).toContain(labHome)
    expect(JSON.stringify(without)).not.toContain(labHome)
  })

  it('a missing file, an unparsable file or a malformed excludedCommands excludes nothing and leaves the settings as they are without the entry', () => {
    const plain = { sandbox: CARD_SESSION_SANDBOX, permissions: { allow: ['Bash(pnpm run quality)', `Edit(/${tree}/**)`] }, env: SESSION_BASH_CAP, hooks: WIDE_VITEST_HOOKS }
    const missing = settings()
    writeFileSync(path.join(tree, '.claude', 'settings.json'), '{ not json')
    const unparsable = settings()
    holdSettings('settings.json', entry)
    const malformed = settings()
    expect([missing, unparsable, malformed]).toStrictEqual([plain, plain, plain])
  })

  it('the card settings layer allows the command of every installed daemon and of no other', () => {
    const plain = ['Bash(pnpm run quality)', `Edit(/${tree}/**)`]
    const without = settings()
    holdSettings('settings.local.json', [OTHER_ENTRY, entry])
    const installed = settings()
    rmSync(browserLabInstalledScript(home))
    const missingProgram = settings()
    expect(shippedDaemonCommands(home)).toEqual([entry])
    expect({ without: without.permissions.allow, installed: installed.permissions.allow, missingProgram: missingProgram.permissions.allow }).toEqual({ without: plain, installed: [...plain, allowRule(entry)], missingProgram: plain })
    expect(installed.permissions.allow).not.toContain(allowRule(OTHER_ENTRY))
    expect(installed.sandbox.excludedCommands).toEqual([entry])
  })

  it('leaves the network and the unsandboxed-command refusal of the card session unchanged with the entry present', () => {
    holdSettings('settings.json', [entry])
    expect(settings().sandbox).toMatchObject(CARD_SESSION_SANDBOX)
  })

  it('spawned settings carry a 30 min Bash cap', () => {
    const without = settings()
    holdSettings('settings.json', [entry])
    const excluded = settings()
    expect(excluded.sandbox.excludedCommands).toEqual([entry])
    expect([without, excluded].map(built => JSON.parse(settingsFlag(built).at(-1)!).env)).toMatchObject([{ BASH_MAX_TIMEOUT_MS: '1800000', BASH_DEFAULT_TIMEOUT_MS: '1800000' }, { BASH_MAX_TIMEOUT_MS: '1800000', BASH_DEFAULT_TIMEOUT_MS: '1800000' }])
  })

  it('the session bash cap disables background tasks', () => {
    const without = settings()
    holdSettings('settings.json', [entry])
    const excluded = settings()
    expect([without, excluded].map(built => JSON.parse(settingsFlag(built).at(-1)!).env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)).toEqual(['1', '1'])
  })

  it('installs the wide-vitest guard on Bash with or without the lab entry', () => {
    const without = settings()
    holdSettings('settings.json', [entry])
    const excluded = settings()
    expect([without, excluded].map(built => JSON.parse(settingsFlag(built).at(-1)!).hooks)).toEqual([WIDE_VITEST_HOOKS, WIDE_VITEST_HOOKS])
  })

  it('keeps the entry and the protection across the --settings flag', () => {
    holdSettings('settings.local.json', [entry])
    const built = settings()
    expect(JSON.parse(settingsFlag(built).at(-1)!)).toEqual(built)
  })

  it('a granted card excluded for the lab keeps both its grant and the lab protection', () => {
    holdSettings('settings.json', [entry])
    const [grant] = CARD_GRANTS
    const built = shiftSettings(tree, GATE, [], home, grant!.card)
    expect({ excluded: built.sandbox.excludedCommands, domains: built.sandbox.network.allowedDomains, allow: built.permissions.allow.slice(-grant!.allow.length), deny: built.permissions.deny?.length, filesystem: built.sandbox.filesystem }).toEqual({ excluded: [entry, ...grant!.excludedCommands], domains: [...grant!.domains], allow: [...grant!.allow], deny: 2, filesystem: { allowWrite: [path.join(home, '.codex')], denyWrite: [path.join(tree, 'scripts', 'construct', 'browser-lab.mjs'), path.join(home, '.construct', 'browser-lab')] } })
  })
})

describe('a card granted by an owner decision gets exactly its grant and no other card gets any', () => {
  const GATE: ShiftGate = { prepush: ['pnpm run quality'], handoffWrite: null, codeMatrix: null }
  const GRANTED = 2156
  const CODEX_HOSTS = ['api.openai.com', 'chatgpt.com', 'auth.openai.com']
  let scratch = ''
  let home = ''

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'construct-shift-grant-'))
    home = path.join(scratch, 'home')
  })

  afterEach(() => {
    plantedGrants.rows = []
    rmSync(scratch, { recursive: true, force: true })
  })

  const PLANTED = 9901

  function plantedRow(excludedCommands: string[]): CardGrant {
    return { card: PLANTED, decision: 'D-0', allow: [], domains: [], homeWrites: [], excludedCommands }
  }

  function plainOf(tree: string): ShiftSettings {
    return { sandbox: CARD_SESSION_SANDBOX, permissions: { allow: ['Bash(pnpm run quality)', `Edit(/${tree}/**)`] }, env: SESSION_BASH_CAP, hooks: WIDE_VITEST_HOOKS }
  }

  it('card #2156 gets codex, mkdir and git init of its fixed scratch directory, Write and Edit inside it, the Codex API and sign-in hosts and ~/.codex by D-705, and nothing else', () => {
    const tree = path.join(scratch, 'worktrees', String(GRANTED))
    const uid = userInfo().uid
    const probe = `/tmp/claude-${uid}/codex-live-hooks`
    const resolved = `/private/tmp/claude-${uid}/codex-live-hooks`
    expect(GRANT_SCRATCH_DIRECTORY).toBe(probe)
    expect(shiftSettings(tree, GATE, [], home)).toStrictEqual({
      sandbox: { ...CARD_SESSION_SANDBOX, network: { ...CARD_SESSION_SANDBOX.network, allowedDomains: CODEX_HOSTS }, excludedCommands: ['codex exec *'], filesystem: { allowWrite: [path.join(home, '.codex')] } },
      permissions: { allow: ['Bash(pnpm run quality)', `Edit(/${tree}/**)`, 'Bash(codex *)', `Bash(mkdir -p ${probe})`, `Bash(mkdir ${probe})`, `Bash(git init ${probe})`, `Write(/${probe}/**)`, `Edit(/${probe}/**)`, `Write(/${resolved}/**)`, `Edit(/${resolved}/**)`] },
      env: SESSION_BASH_CAP,
      hooks: WIDE_VITEST_HOOKS,
    })
    expect(grantOf(GRANTED)?.decision).toBe('D-705')
  })

  it('every other card, a tree that names no card and an explicit null get the layer with no network and no extra rule', () => {
    const others = [String(GRANTED - 1), String(GRANTED + 1), `x${GRANTED}`, `${GRANTED}-copy`, 'construct-shift-tree']
    const built = others.map(name => path.join(scratch, name)).map(tree => ({ got: shiftSettings(tree, GATE, [], home), plain: plainOf(tree) }))
    const forced = path.join(scratch, String(GRANTED))
    expect(built.map(({ got }) => got)).toStrictEqual(built.map(({ plain }) => plain))
    expect(shiftSettings(forced, GATE, [], home, null)).toStrictEqual(plainOf(forced))
  })

  it('card #2156 runs codex exec outside the sandbox by D-765 and no other card excludes anything', () => {
    const granted = shiftSettings(path.join(scratch, String(GRANTED)), GATE, [], home)
    const others = [GRANTED - 1, GRANTED + 1, null].map(card => shiftSettings(path.join(scratch, String(GRANTED)), GATE, [], home, card))
    expect(granted.sandbox.excludedCommands).toEqual(['codex exec *'])
    expect(JSON.parse(settingsFlag(granted).at(-1)!).sandbox.excludedCommands).toEqual(['codex exec *'])
    expect(granted.sandbox).toMatchObject({ allowUnsandboxedCommands: false })
    expect(others.map(built => built.sandbox.excludedCommands)).toEqual([undefined, undefined, undefined])
    expect(CARD_GRANTS.filter(grant => grant.excludedCommands.length > 0).map(grant => ({ card: grant.card, excluded: grant.excludedCommands }))).toEqual([{ card: GRANTED, excluded: ['codex exec *'] }])
  })

  it('a granted exclusion and an installed daemon both reach excludedCommands', () => {
    const tree = path.join(scratch, 'worktrees', String(GRANTED))
    const entry = browserLabExcludedCommand(home)
    mkdirSync(path.join(tree, '.claude'), { recursive: true })
    writeFileSync(path.join(tree, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands: [entry, 'codex exec *'] } }))
    mkdirSync(path.dirname(browserLabInstalledScript(home)), { recursive: true })
    writeFileSync(browserLabInstalledScript(home), '')
    const built = shiftSettings(tree, GATE, [], home)
    const other = shiftSettings(tree, GATE, [], home, GRANTED + 1)
    expect({ granted: built.sandbox.excludedCommands, other: other.sandbox.excludedCommands }).toEqual({ granted: [entry, 'codex exec *'], other: [entry] })
    expect(built.permissions.allow).toContain(allowRule(entry))
  })

  it('a granted exclusion equal to an installed daemon command reaches excludedCommands once', () => {
    const tree = path.join(scratch, 'worktrees', String(PLANTED))
    const entry = browserLabExcludedCommand(home)
    mkdirSync(path.join(tree, '.claude'), { recursive: true })
    writeFileSync(path.join(tree, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands: [entry] } }))
    mkdirSync(path.dirname(browserLabInstalledScript(home)), { recursive: true })
    writeFileSync(browserLabInstalledScript(home), '')
    plantedGrants.rows = [plantedRow([entry])]
    const built = shiftSettings(tree, GATE, [], home)
    expect(built.sandbox.excludedCommands).toEqual([entry])
    expect(JSON.parse(settingsFlag(built).at(-1)!).sandbox.excludedCommands).toEqual([entry])
  })

  it('a granted row with no excluded command leaves the sandbox with no excludedCommands key', () => {
    const tree = path.join(scratch, 'worktrees', String(PLANTED))
    plantedGrants.rows = [plantedRow([])]
    const { sandbox } = shiftSettings(tree, GATE, [], home)
    expect(Object.hasOwn(sandbox, 'excludedCommands')).toBe(false)
    expect(sandbox).toStrictEqual({ ...CARD_SESSION_SANDBOX, network: { ...CARD_SESSION_SANDBOX.network, allowedDomains: [] } })
  })

  it('the card is read from the tree name the bus gives it, in either home', () => {
    expect([`/bus/worktrees/${GRANTED}`, `/home/mc-${GRANTED}`, `/bus/worktrees/${GRANTED}/`, '/bus/worktrees/mc-x', `/bus/worktrees/${GRANTED}.bak`].map(cardOfTree)).toEqual([GRANTED, GRANTED, GRANTED, null, null])
  })

  it('the grant reaches the session through the --settings flag', () => {
    const built = shiftSettings(path.join(scratch, String(GRANTED)), GATE, [], home)
    expect(JSON.parse(settingsFlag(built).at(-1)!).sandbox.network.allowedDomains).toEqual(CODEX_HOSTS)
  })

  it('card 2156 grant carries the ChatGPT login hosts and no other card gets them', () => {
    const LOGIN_HOSTS = ['chatgpt.com', 'auth.openai.com']
    const granted = shiftSettings(path.join(scratch, String(GRANTED)), GATE, [], home)
    const others = [GRANTED - 1, GRANTED + 1, null].map(card => shiftSettings(path.join(scratch, String(GRANTED)), GATE, [], home, card))
    const hostsOf = (built: ShiftSettings): string[] => built.sandbox.network.allowedDomains ?? []
    expect(LOGIN_HOSTS.every(host => hostsOf(granted).includes(host))).toBe(true)
    expect(hostsOf(granted)).toContain('api.openai.com')
    expect(others.map(built => ({ hosts: hostsOf(built), filesystem: built.sandbox.filesystem }))).toEqual([{ hosts: [], filesystem: undefined }, { hosts: [], filesystem: undefined }, { hosts: [], filesystem: undefined }])
  })

  it('every row of the table names one card once, an owner decision, Bash rules and file rules confined to its scratch directory only, and bare host names', () => {
    const confined = (rule: string): boolean => {
      const file = /^(?:Write|Edit)\(\/(\/.+)\)$/.exec(rule)?.[1]
      if (file === undefined || file.split('/').includes('..'))
        return false
      return GRANT_SCRATCH_SPELLINGS.some(scratch => file.startsWith(`${scratch}/`))
    }
    const cards = CARD_GRANTS.map(grant => grant.card)
    const rows = CARD_GRANTS.map(grant => ({
      decision: /^D-\d+$/.test(grant.decision),
      rules: grant.allow.every(rule => /^Bash\(.+\)$/.test(rule) || confined(rule)),
      hosts: grant.domains.every(host => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)),
      homeWrites: grant.homeWrites.every(entry => entry !== '' && !path.isAbsolute(entry) && !entry.split('/').includes('..')),
      excluded: grant.excludedCommands.every(command => command.trim() === command && command !== ''),
    }))
    expect(new Set(cards).size).toBe(cards.length)
    expect(rows.every(row => row.decision && row.rules && row.hosts && row.homeWrites && row.excluded)).toBe(true)
  })
})

describe('the browser lab exclusion a card tree takes from its main checkout', () => {
  const OTHER_ENTRY = 'bash *'
  const GATE: ShiftGate = { prepush: ['pnpm run quality'], handoffWrite: null, codeMatrix: null }
  let scratch = ''
  let main = ''
  let tree = ''
  let home = ''
  let entry = ''

  function git(...args: string[]): void {
    execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' })
  }

  function holdInMain(excludedCommands: unknown): void {
    mkdirSync(path.join(main, '.claude'), { recursive: true })
    writeFileSync(path.join(main, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands } }))
  }

  function settings(): ShiftSettings {
    return shiftSettings(tree, GATE, [], home)
  }

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-shift-main-')))
    main = path.join(scratch, 'main')
    tree = path.join(scratch, 'card-tree')
    home = path.join(scratch, 'home')
    entry = browserLabExcludedCommand(home)
    mkdirSync(main)
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'base')
    git('worktree', 'add', '-q', '--detach', tree)
    mkdirSync(path.dirname(browserLabInstalledScript(home)), { recursive: true })
    writeFileSync(browserLabInstalledScript(home), '')
  })

  afterEach(() => rmSync(scratch, { recursive: true, force: true }))

  it('a card tree with no local settings gets the entry from its main checkout', () => {
    holdInMain([entry])
    const built = settings()
    expect(existsSync(path.join(tree, '.claude', 'settings.local.json'))).toBe(false)
    expect(built.sandbox.excludedCommands).toEqual([entry])
    expect(built.permissions.deny).toContain(`Edit(/${path.join(tree, 'scripts', 'construct', 'browser-lab.mjs')})`)
  })

  it('any other entry in the main checkout never reaches the session settings', () => {
    holdInMain([OTHER_ENTRY, entry])
    const together = settings().sandbox.excludedCommands
    holdInMain([OTHER_ENTRY])
    expect({ together, alone: settings().sandbox.excludedCommands }).toEqual({ together: [entry], alone: undefined })
  })

  it('the entry in the main checkout opens nothing when the installed script is missing', () => {
    holdInMain([entry])
    rmSync(browserLabInstalledScript(home))
    expect(settings().sandbox.excludedCommands).toBeUndefined()
  })

  it('a tree\'s own file still excludes the lab when the main checkout does not', () => {
    mkdirSync(path.join(tree, '.claude'))
    writeFileSync(path.join(tree, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands: [entry] } }))
    expect(settings().sandbox.excludedCommands).toEqual([entry])
  })

  it('a main checkout without the file, or a tree whose git pointer leads nowhere, excludes nothing', () => {
    const noFile = settings().sandbox.excludedCommands
    holdInMain([entry])
    writeFileSync(path.join(tree, '.git'), 'gitdir: /nowhere/at/all\n')
    const brokenPointer = settings().sandbox.excludedCommands
    writeFileSync(path.join(tree, '.git'), 'not a pointer\n')
    expect({ noFile, brokenPointer, noPointer: settings().sandbox.excludedCommands }).toEqual({ noFile: undefined, brokenPointer: undefined, noPointer: undefined })
  })

  it('a pointer into a git directory not named .git names no main checkout', () => {
    holdInMain([entry])
    const elsewhere = path.join(scratch, 'elsewhere', 'worktrees', 'x')
    mkdirSync(path.join(scratch, 'elsewhere', '.claude'), { recursive: true })
    writeFileSync(path.join(scratch, 'elsewhere', '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { excludedCommands: [entry] } }))
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(path.join(elsewhere, 'commondir'), '../..\n')
    writeFileSync(path.join(tree, '.git'), `gitdir: ${elsewhere}\n`)
    expect(settings().sandbox.excludedCommands).toBeUndefined()
  })
})
