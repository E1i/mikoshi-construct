import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const ADAPTERS = 'scripts/ports/client/'
const SCANNED = ['scripts/', 'src/']
const TREE_ROOTS = ['scripts', 'src', '.claude', 'templates']

const CLIENT_LITERALS: readonly RegExp[] = [
  /['"`$.]CLAUDE_/,
  /['"`]claude['"`]/,
  /\bclaude (?:-p|--[a-z])/,
  /--(?:permission-mode|permission-prompts|strict-mcp-config|session-id|output-format|add-dir|resume|setting-sources|dangerously-skip-permissions)\b/,
  /\.claude\/settings|~\/\.claude|['"`]\.claude['"`]/,
  /['"`]codex['"`]/,
  /\bcodex exec\b/,
]

interface Carrier {
  path: string
  reason: string
  literal?: RegExp
}

const GOLDEN_PIN_TESTS = [
  'bus/answer-node',
  'bus/answer-queue',
  'bus/answerer',
  'bus/chain-process',
  'bus/continuationhandoff',
  'bus/eddiesline',
  'bus/eddiesline150',
  'bus/heartbeat',
  'bus/ladder-starter',
  'bus/launch-ladder-handoff',
  'bus/launch-node',
  'bus/launch-queue',
  'bus/launch-starter',
  'bus/policy',
  'bus/review-worker',
  'bus/reviewer',
  'bus/reviewloop',
  'bus/shardlabel',
  'bus/window-heartbeat',
  'client/codex-reading',
  'client/contract',
  'client/identity',
  'client/process',
  'client/reading',
  'client/seal',
  'client/spawn',
  'client/startcost',
  'client/startcost-hooks',
  'client/window',
  'core/factory-paths',
  'ghosts/task-start-entry',
  'ghosts/task-start',
  'ghosts/watch-process',
  'miko/compact-start',
  'miko/eddies-measure',
  'miko/exit',
  'miko/loop',
  'miko/miko-repo',
  'miko/pre-compact',
  'miko/pull',
  'miko/sandbox-law',
  'miko/stop-hook',
  'miko/turn-watch',
  'miko/watch',
  'miko/windowloop',
  'owner/channel',
  'ports/isolation',
  'ports/session',
  'shift/handoff-write',
  'shift/runner-removed',
  'shift/setting-sources',
  'shift/shard',
  'shift/shift-settings',
  'shift/tree-pr-cli',
  'shredder/owner-merges',
]

const CARRIERS: readonly Carrier[] = [
  { path: '.claude/**', reason: 'the configuration of the client itself, which only this client reads' },
  ...GOLDEN_PIN_TESTS.map(test => ({ path: `scripts/tests/${test}.test.ts`, reason: 'golden pin: the test states the argv and the variables the adapter must produce' })),
  { path: 'scripts/tests/ghosts/fixtures/world.sh', reason: 'the fake client a ghost fixture runs in place of the binary' },
  { path: 'scripts/tests/ghosts/watch-fixtures/world.sh', reason: 'the fake client a watch fixture runs in place of the binary' },
  { path: 'scripts/ports/shift-settings.ts', reason: 'the settings a card session runs under, with their flags; called by the adapter' },
  { path: 'scripts/ports/isolation.ts', reason: 'reads which settings the client would load, to refuse a card session without isolation' },
  { path: 'scripts/nodes/launch/launch-starter.ts', reason: 'the card argv launchArgv spawns, pinned against the adapter by the contract goldens' },
  { path: 'scripts/window/eddies-measure.ts', reason: 'the window side of the hook that the client calls with its project variable' },
  { path: 'scripts/window/window-heartbeat.ts', reason: 'the project variable the client gives its hooks' },
  { path: 'scripts/contract/json-samples.ts', reason: 'the variables that mark a run inside an agent runtime' },
  { path: 'scripts/policy/touch-scope.ts', reason: 'the .claude directory never follows a card, and the settings file is a path of the factory manifest' },
  { path: 'scripts/harness-command/render.ts', reason: 'renders the template group of the claude AI target, a template choice and not a session' },
  { path: 'src/commands/attach/carriers.ts', reason: 'C12: ai claude in the attach plan; moves to clientconfig in 0.47, record 0060' },
  { path: 'src/commands/attach/settings.ts', reason: 'writes the guard into the settings file attach owns, with the project variable' },
  { path: 'src/commands/cost/claude-code.ts', reason: 'the CostSource of this runtime reads its session files' },
  { path: 'src/commands/cost/runtime.ts', reason: 'the variables that name the runtime a cost report reads' },
  { path: 'src/commands/doctor/factory.ts', reason: 'doctor names the settings files and the command that opens a window' },
  { path: 'src/commands/init.ts', reason: 'the claude AI target and review provider are init options, and it merges the settings file' },
  { path: 'src/card/complexity.ts', reason: 'counts the .claude directory as a path kind' },
  { path: 'src/card/risk.ts', reason: 'maps .claude to the templates it comes from' },
  { path: 'src/manifest.ts', reason: 'the client ids construct.json may name, which doctor reads where the factory adapters cannot be imported; scripts/tests/client/config.test.ts holds them equal to the adapters' },
  { path: 'src/materialize/rules.ts', reason: 'the rules of the claude AI target' },
  { path: 'src/materialize/strategies.ts', reason: 'the settings file merges its hooks' },
  { path: 'src/presets/index.ts', reason: 'the AI targets and review providers a preset names' },
  { path: 'src/ui/lore.ts', reason: 'user-facing lines name the settings file the person edits' },
  { path: 'src/ui/prompts.ts', reason: 'the prompt that picks the claude AI target' },
  { path: 'templates/ai/claude/_claude/eddies.json', reason: 'T1: the context windows of the client\'s model ids', literal: /claude-/ },
  { path: 'templates/ai/claude/scripts/construct/eddies.mjs', reason: 'T2: the nested-session pattern and the continuation line' },
  { path: 'templates/ai/claude/scripts/construct/check-acceptance.mjs', reason: 'T3: the template copy reads CLAUDE.md', literal: /CLAUDE\.md/ },
  { path: 'templates/ai/claude/_claude/settings.json', reason: 'T4: the deny of the settings and eddies paths' },
]

function covers(row: string, file: string): boolean {
  return row.endsWith('/**') ? file.startsWith(row.slice(0, -2)) : file === row
}

function holdsLiteral(text: string): boolean {
  return CLIENT_LITERALS.some(literal => literal.test(text))
}

function isScanned(file: string): boolean {
  return SCANNED.some(root => file.startsWith(root)) && !file.startsWith(ADAPTERS)
}

function sealOf(tree: ReadonlyMap<string, string>, carriers: readonly Carrier[]): { outside: string[], stale: string[] } {
  const files = [...tree]
  const outside = files.filter(([file, text]) => isScanned(file) && holdsLiteral(text) && !carriers.some(carrier => covers(carrier.path, file))).map(([file]) => file)
  const stale = carriers.filter(carrier => !files.some(([file, text]) => covers(carrier.path, file) && (carrier.literal?.test(text) ?? holdsLiteral(text)))).map(carrier => carrier.path)
  return { outside, stale }
}

function realTree(): Map<string, string> {
  const listed = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-co', '--exclude-standard', '--', ...TREE_ROOTS], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const files = listed.split('\n').filter(file => file !== '' && existsSync(path.join(REPO_ROOT, file)) && statSync(path.join(REPO_ROOT, file)).isFile())
  return new Map(files.map(file => [file, readFileSync(path.join(REPO_ROOT, file), 'utf8')]))
}

describe('the client seal', () => {
  it('a client literal outside the adapter and the table fails', () => {
    const planted = ['spawn(\'claude\')', 'process.env.CLAUDE_CONFIG_DIR', 'run(`claude -p`)', 'args.push(\'--session-id\')', 'read(\'~/.claude/settings.json\')', 'spawn(\'codex\')', 'run(`codex exec --json`)']
    for (const line of planted) {
      const tree = new Map([['scripts/nodes/planted.ts', line], ['scripts/ports/client/claude/adapter.ts', line], ['scripts/ports/carried.ts', line], ['templates/outside.ts', line]])
      expect(sealOf(tree, [{ path: 'scripts/ports/carried.ts', reason: 'a sample' }]).outside, line).toEqual(['scripts/nodes/planted.ts'])
      expect(sealOf(new Map([['scripts/tests/bus/planted.test.ts', line]]), CARRIERS).outside, line).toEqual(['scripts/tests/bus/planted.test.ts'])
    }
    expect(sealOf(realTree(), CARRIERS).outside).toEqual([])
  })

  it('a table row with no literal left fails', () => {
    const tree = new Map([['scripts/ports/emptied.ts', 'nothing of the client here'], ['scripts/ports/carried.ts', '\'claude\'']])
    const carriers: Carrier[] = [
      { path: 'scripts/ports/emptied.ts', reason: 'a sample' },
      { path: 'scripts/ports/carried.ts', reason: 'a sample' },
      { path: 'scripts/ports/deleted.ts', reason: 'a sample' },
      { path: 'scripts/ports/carried.ts', reason: 'a sample with a literal of its own', literal: /model-id/ },
    ]
    expect(sealOf(tree, carriers).stale).toEqual(['scripts/ports/emptied.ts', 'scripts/ports/deleted.ts', 'scripts/ports/carried.ts'])
    expect(sealOf(realTree(), CARRIERS).stale).toEqual([])
  })

  it('every carrier states its reason', () => {
    expect(CARRIERS.filter(carrier => carrier.reason.trim() === '')).toEqual([])
  })
})
