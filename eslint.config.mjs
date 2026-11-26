import { execFileSync } from 'node:child_process'
import path from 'node:path'
import antfu from '@antfu/eslint-config'
import ESLINT_EDGES from './contract/eslint-edges.json' with { type: 'json' }
import MODULE_FILES from './contract/module-files.json' with { type: 'json' }
import SURFACE from './contract/surface.json' with { type: 'json' }
import INTERNAL_MODULES from './internal-modules.json' with { type: 'json' }
import FOREIGN_TABLE_SQL_EXCEPTED from './scripts/quality/foreign-table-sql-excepted.json' with { type: 'json' }
import REAL_TIME_WAITS_EXCEPTED from './scripts/quality/real-time-waits-excepted.json' with { type: 'json' }
import TABLE_OWNERS from './scripts/quality/table-owners.json' with { type: 'json' }

const ALLOWED_INTERNAL_IMPORTS = ESLINT_EDGES.allowedInternalImports
const ALLOWED_FACTORY_IMPORTS = ESLINT_EDGES.allowedFactoryImports

function factoryReach(target) {
  const allowed = ALLOWED_FACTORY_IMPORTS[target] ?? []
  const kept = allowed.map(name => name.endsWith('/') ? name : `${name}$`).map(name => name.replaceAll('.', '\\.'))
  return {
    regex: kept.length === 0 ? '^(?:\\.\\./)+scripts/' : `^(?:\\.\\./)+scripts/(?!${kept.join('|')})`,
    message: allowed.length === 0
      ? `${target.replace(/\.ts$/, '')} imports no factory module under scripts/: the factory ships as its own build`
      : `${target.replace(/\.ts$/, '')} may reach into scripts/ only through ${allowed.join(', ')}: the factory ships as its own build`,
  }
}

function dependencyBoundary([target, allowed]) {
  const forbidden = INTERNAL_MODULES.filter(name => !allowed.includes(name))
  const directory = target.replace(/\.ts$/, '')
  return {
    files: [target.endsWith('.ts') ? target : `${target}/**`],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: forbidden.flatMap(name => ['.', '..', '../..'].flatMap(base => [`${base}/${name}`, `${base}/${name}.js`, `${base}/${name}/*`])),
          message: allowed.length === 0
            ? `${directory} imports no other src module: it returns facts`
            : `${directory} may import only ${allowed.join(', ')}`,
        }, factoryReach(target)],
      }],
    },
  }
}

const dependencyBoundaries = Object.entries(ALLOWED_INTERNAL_IMPORTS).map(dependencyBoundary)

const READS_GO_THROUGH_ONE_READER = 'doctor audits a repository it does not trust: every read goes through FileReadings in src/commands/doctor/readings.ts, which reports a path it cannot read instead of dropping it from the set it inspected'

const doctorReadsThroughOneReader = {
  files: ['src/commands/doctor/**'],
  ignores: ['src/commands/doctor/readings.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [dependencyBoundary(['src/commands', ALLOWED_INTERNAL_IMPORTS['src/commands']]).rules['no-restricted-imports'][1].patterns[0], factoryReach('src/commands/doctor')],
      paths: [{ name: 'node:fs', importNames: ['readFileSync', 'readdirSync'], message: READS_GO_THROUGH_ONE_READER }],
    }],
  },
}

const intakeReadsDecisionsThroughTheirParser = {
  files: ['src/commands/intake/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [dependencyBoundary(['src/commands', ALLOWED_INTERNAL_IMPORTS['src/commands']]).rules['no-restricted-imports'][1].patterns[0], factoryReach('src/commands/intake')],
    }],
  },
}

const boardTakesRolesAndVerdictsFromTheirOwners = {
  files: ['src/commands/board/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [dependencyBoundary(['src/commands', ALLOWED_INTERNAL_IMPORTS['src/commands']]).rules['no-restricted-imports'][1].patterns[0], factoryReach('src/commands/board')],
    }],
  },
}

const ATTACH_DECIDES_WITHOUT_THE_STACK = 'attach decides without reading the stack (0034): it refuses only a tree with nothing to attach to'

const attachDecidesWithoutTheStack = {
  files: ['src/commands/attach/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        dependencyBoundary(['src/commands', ALLOWED_INTERNAL_IMPORTS['src/commands']]).rules['no-restricted-imports'][1].patterns[0],
        factoryReach('src/commands/attach'),
        { group: ['../../detect', '../../detect/*'], allowImportNames: ['isEmptyDir'], message: ATTACH_DECIDES_WITHOUT_THE_STACK },
      ],
    }],
  },
}

const ANTFU_RESTRICTED_SYNTAX = ['TSEnumDeclaration[const=true]', 'TSExportAssignment']

const SPAWNS_ONLY_FIXED_READS = 'The CLI spawns nothing but `pnpm --version` in src/detect/package-manager.ts and the read-only `git rev-parse HEAD` and `git ls-files -z` in src/detect/git.ts, and `bash -n -c <witness>` in src/commands/intake/bash-syntax.ts'
const RUNS_ONLY_SHIPPED_CODE = 'The CLI runs only the code it ships: doctor audits a repository it does not trust, so src/ reads file text and never loads or runs code from it'

const NO_CHILD_PROCESS = [
  { selector: 'ImportDeclaration[source.value="node:child_process"]', message: SPAWNS_ONLY_FIXED_READS },
]

const NO_RUNTIME_CODE_LOADING = [
  { selector: 'ImportExpression', message: RUNS_ONLY_SHIPPED_CODE },
  { selector: 'CallExpression[callee.name="require"]', message: RUNS_ONLY_SHIPPED_CODE },
  { selector: 'MemberExpression[object.name="require"]', message: RUNS_ONLY_SHIPPED_CODE },
  { selector: 'ImportDeclaration[source.value="node:module"]', message: RUNS_ONLY_SHIPPED_CODE },
  { selector: 'Identifier[name="createRequire"]', message: RUNS_ONLY_SHIPPED_CODE },
]

const FROZEN_INIT_RECORD = 'construct.json holds two records: files is the frozen init record and never the latest state. Read recordedShas(manifest), which overlays the sync record — reading .files directly reports a synced file as modified'

const NO_BARE_INIT_RECORD = [
  { selector: 'MemberExpression[property.name="files"][object.name=/^(manifest|previous)$/]', message: FROZEN_INIT_RECORD },
]

const spawnPolicy = {
  files: ['src/**'],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_CHILD_PROCESS, ...NO_RUNTIME_CODE_LOADING, ...NO_BARE_INIT_RECORD],
  },
}

const thePnpmProbeMaySpawnAndNothingElse = {
  files: ['src/detect/package-manager.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_RUNTIME_CODE_LOADING, ...NO_BARE_INIT_RECORD],
  },
}

const theGitReadingsMaySpawnAndNothingElse = {
  files: ['src/detect/git.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_RUNTIME_CODE_LOADING, ...NO_BARE_INIT_RECORD],
  },
}

const theIntakeBashSyntaxCheckMaySpawnAndNothingElse = {
  files: ['src/commands/intake/bash-syntax.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_RUNTIME_CODE_LOADING, ...NO_BARE_INIT_RECORD],
  },
}

const theRecordItselfMayReadBothHalves = {
  files: ['src/manifest.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_CHILD_PROCESS, ...NO_RUNTIME_CODE_LOADING],
  },
}

const A_HOOK_READS_STDIN_TO_ITS_END = 'A hook is fed through a pipe its parent may write late, in pieces or large: read stdin to its end asynchronously (for await of process.stdin) and never swallow a read error — a guard refuses with exit 2, a recorder writes an unread line and exits 0'
const HOOK_SCRIPTS = ['.claude/hooks/**', 'templates/attach/_construct/**']
const STDIN_ARGUMENT = '[arguments.0.value=0], [arguments.0.value="/dev/stdin"], [arguments.0.property.name="fd"]'

const NO_SYNCHRONOUS_STDIN = ['readFileSync', 'readSync'].flatMap(name => [
  { selector: `CallExpression[callee.name="${name}"]:matches(${STDIN_ARGUMENT})`, message: A_HOOK_READS_STDIN_TO_ITS_END },
  { selector: `CallExpression[callee.property.name="${name}"]:matches(${STDIN_ARGUMENT})`, message: A_HOOK_READS_STDIN_TO_ITS_END },
])

const aHookReadsStdinToItsEnd = {
  files: HOOK_SCRIPTS,
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_SYNCHRONOUS_STDIN],
  },
}

const AN_EVENT_IS_READ_THROUGH_THE_CONTRACT = 'An event payload crosses the bus boundary through one reader: payloadOf in scripts/core/stored.ts, then declaredPart or catalogued, which scripts/core/events.ts generates from contract/factory.json — never a hand-written JSON.parse of a payload'

const NO_HAND_EVENT_READERS = [
  { selector: 'CallExpression[callee.object.name="JSON"][callee.property.name="parse"]:matches([arguments.0.name="payload"], [arguments.0.property.name="payload"])', message: AN_EVENT_IS_READ_THROUGH_THE_CONTRACT },
]

export const HAND_EVENT_READERS_EXCEPTED = [
  'scripts/cli/card-chain.ts',
  'scripts/core/bus-version.ts',
  'scripts/core/card-bodies.ts',
  'scripts/core/inbox.ts',
  'scripts/core/journal.ts',
  'scripts/core/lease.ts',
  'scripts/core/legacy-history.ts',
  'scripts/core/report.ts',
  'scripts/core/stored.ts',
  'scripts/intake/admissions.ts',
  'scripts/intake/witness-fields-backfill.ts',
  'scripts/nodes/answer/answer-executor.ts',
  'scripts/nodes/close/close-executor.ts',
  'scripts/nodes/launch/lane-assign.ts',
  'scripts/nodes/launch/launch-candidates.ts',
  'scripts/nodes/launch/launch-worker.ts',
  'scripts/nodes/update/update-executor.ts',
  'scripts/window/card-measure.ts',
  'scripts/window/requests/amend.ts',
  'scripts/window/requests/owner-wait-close.ts',
  'scripts/window/watch.ts',
  'scripts/window/window-requests.ts',
  'scripts/window/window.ts',
]

const anEventIsReadThroughTheContract = {
  files: ['scripts/**'],
  ignores: ['scripts/tests/**', ...HAND_EVENT_READERS_EXCEPTED],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_HAND_EVENT_READERS],
  },
}

export const SURFACE_COMMAND_NAMES = Object.entries(SURFACE.commands).filter(([, command]) => 'flags' in command).map(([name]) => name).sort()
export const SURFACE_FORMAT_FIELDS = Object.keys(SURFACE.formats).sort()
export const COMMAND_NAMES_THAT_MAKE_A_LIST = 3
const THE_SURFACE_GENERATOR = 'scripts/contract/**'

const A_COMMAND_CROSSES_THROUGH_THE_CONTRACT = 'A CLI command crosses the boundary through CONTRACT_COMMANDS and ContractCommand, which scripts/contract/surface.ts generates from contract/surface.json — never a hand-written list, table or union of command names'
const A_FORMAT_VERSION_IS_READ_THROUGH_THE_CONTRACT = 'A contract file\'s version is read through formatVersion and ContractFormat, which scripts/contract/surface.ts generates from contract/surface.json — never a hand-written read of {{field}}'

function jsonParseAt(at) {
  return `[${at}.callee.object.name="JSON"][${at}.callee.property.name="parse"]`
}

export const HAND_SURFACE_BOUNDARIES_EXCEPTED = [
  'scripts/cli/board-page.ts',
]

function literalName(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node?.type === 'TSLiteralType')
    return literalName(node.literal)
  return null
}

function keyName(node) {
  if (node.computed)
    return literalName(node.key)
  return node.key.type === 'Identifier' ? node.key.name : literalName(node.key)
}

function commandNamesIn(names) {
  return new Set(names.filter(name => name !== null && SURFACE_COMMAND_NAMES.includes(name)))
}

const noHandWrittenSurfaceBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { commands: A_COMMAND_CROSSES_THROUGH_THE_CONTRACT, format: A_FORMAT_VERSION_IS_READ_THROUGH_THE_CONTRACT },
  },
  create(context) {
    const reportList = (node, names) => {
      if (commandNamesIn(names).size >= COMMAND_NAMES_THAT_MAKE_A_LIST)
        context.report({ node, messageId: 'commands' })
    }
    const reportField = (node, field) => {
      if (field !== null && SURFACE_FORMAT_FIELDS.includes(field))
        context.report({ node, messageId: 'format', data: { field } })
    }
    return {
      ArrayExpression: node => reportList(node, node.elements.map(literalName)),
      ObjectExpression: node => reportList(node, node.properties.filter(property => property.type === 'Property').map(keyName)),
      TSUnionType: node => reportList(node, node.types.map(literalName)),
      [`TSAsExpression${jsonParseAt('expression')} TSPropertySignature`]: node => reportField(node, keyName(node)),
      [`MemberExpression:matches(${jsonParseAt('object')}, ${jsonParseAt('object.expression')})`]: node => reportField(node, node.computed ? literalName(node.property) : node.property.name),
    }
  },
}

const aSurfaceBoundaryIsGenerated = {
  files: ['scripts/**/*.{ts,mts,cts,js,mjs,cjs}'],
  ignores: ['scripts/tests/**', THE_SURFACE_GENERATOR, ...HAND_SURFACE_BOUNDARIES_EXCEPTED],
  plugins: { contract: { rules: { 'no-hand-written-surface-boundary': noHandWrittenSurfaceBoundary } } },
  rules: { 'contract/no-hand-written-surface-boundary': 'error' },
}

const ROOT = import.meta.dirname
const AGENT_WORKTREES = '.claude/worktrees/**'

function registeredWorktrees() {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length))
  }
  catch {
    return []
  }
}

function nestedWorktrees() {
  return registeredWorktrees()
    .map(worktree => path.relative(ROOT, worktree))
    .filter(relative => relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative))
    .map(relative => `${relative.split(path.sep).join('/')}/**`)
}

const THE_SURFACE_TEST_NEVER_WRITES = 'tests/contract/surface.test.ts compares and never writes (0030): contract/surface.json is written only by `pnpm contract:update`'
const FS_WRITES = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'mkdir', 'mkdirSync', 'cpSync', 'copyFile', 'copyFileSync', 'rename', 'renameSync', 'createWriteStream']

const theSurfaceTestNeverWrites = {
  files: ['tests/contract/surface.test.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].map(name => ({ name, importNames: FS_WRITES, message: THE_SURFACE_TEST_NEVER_WRITES })),
    }],
  },
}

const A_TEST_WAITS_ON_AN_EVENT = 'A test never waits on real time: await the event or the promise, and take time and timers from an injected clock (clock.setTimeout, clock.now) — setTimeout, setInterval, sleep and node:timers are a wait the scheduler decides'

const NO_REAL_TIME_WAITS = [
  { selector: 'CallExpression[callee.name=/^(setTimeout|setInterval|sleep)$/]', message: A_TEST_WAITS_ON_AN_EVENT },
  { selector: 'CallExpression[callee.object.name=/^(globalThis|global|window)$/][callee.property.name=/^(setTimeout|setInterval)$/]', message: A_TEST_WAITS_ON_AN_EVENT },
  { selector: 'ImportDeclaration[source.value=/^(node:)?timers(.promises)?$/]', message: A_TEST_WAITS_ON_AN_EVENT },
]

const aTestWaitsOnAnEvent = {
  files: ['scripts/tests/**', 'tests/**'],
  ignores: REAL_TIME_WAITS_EXCEPTED,
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_REAL_TIME_WAITS],
  },
}

export const COMPOSITION_ROOT = 'scripts/supervisor/composition.ts'
export const REGISTRATION_LISTS = ['folds', 'incremental']
export const IMPORT_TIME_REGISTRY_WRITES = ['push', 'unshift', 'splice', 'set', 'add']
const REGISTERING_CALLEE = /^register/

const REGISTERS_ONLY_IN_COMPOSITION = `Registration happens only in ${COMPOSITION_ROOT} (D-506): a module exports what it defines, and the composition lists it — no list of {{what}} outside it, and no registration at import time`
const COMPOSITION_HAS_NO_IMPORT_SIDE_EFFECTS = `${COMPOSITION_ROOT} has no side effects on import (D-506): it declares imports, types, functions and constant values, and registers only inside the functions a process root calls`

function runsAtImport(node) {
  for (let at = node.parent; at != null; at = at.parent) {
    if (at.type === 'FunctionDeclaration' || at.type === 'FunctionExpression' || at.type === 'ArrowFunctionExpression')
      return false
    if (at.type === 'PropertyDefinition' && !at.static)
      return false
  }
  return true
}

function calleeName(callee) {
  if (callee.type === 'Identifier')
    return { name: callee.name, method: null }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier')
    return { name: callee.property.name, method: callee.property.name }
  return { name: null, method: null }
}

function receiverOf(callee) {
  let at = callee.object
  while (at?.type === 'MemberExpression')
    at = at.object
  return at?.type === 'Identifier' ? at.name : null
}

function variableNamed(scope, name) {
  for (let at = scope; at != null; at = at.upper) {
    const found = at.set.get(name)
    if (found !== undefined)
      return found
  }
  return null
}

function exportedNames(program) {
  return new Set(program.body.flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration')
      return []
    if (statement.declaration?.type === 'VariableDeclaration')
      return statement.declaration.declarations.flatMap(declarator => declarator.id.type === 'Identifier' ? [declarator.id.name] : [])
    return statement.specifiers.flatMap(specifier => specifier.local.type === 'Identifier' ? [specifier.local.name] : [])
  }))
}

function sharedAcrossModules(context, call) {
  const name = receiverOf(call.callee)
  if (name === null)
    return false
  const variable = variableNamed(context.sourceCode.getScope(call), name)
  if (variable === null)
    return false
  return variable.defs.some(definition => definition.type === 'ImportBinding') || exportedNames(context.sourceCode.ast).has(name)
}

function writesARegistry(context, call) {
  const { name, method } = calleeName(call.callee)
  if (name !== null && REGISTERING_CALLEE.test(name))
    return true
  return method !== null && IMPORT_TIME_REGISTRY_WRITES.includes(method) && sharedAcrossModules(context, call)
}

const registersOnlyInComposition = {
  meta: {
    type: 'problem',
    schema: [{ type: 'object', properties: { anywhere: { type: 'boolean' } }, additionalProperties: false }],
    messages: { registers: REGISTERS_ONLY_IN_COMPOSITION },
  },
  create(context) {
    const anywhere = context.options[0]?.anywhere === true
    return {
      Property(node) {
        const key = node.key.type === 'Identifier' ? node.key.name : node.key.value
        if (node.value.type === 'ArrayExpression' && REGISTRATION_LISTS.includes(key) && (anywhere || runsAtImport(node)))
          context.report({ node, messageId: 'registers', data: { what: key } })
      },
      CallExpression(node) {
        if (runsAtImport(node) && writesARegistry(context, node))
          context.report({ node, messageId: 'registers', data: { what: calleeName(node.callee).name } })
      },
    }
  },
}

const SIDE_EFFECT_FREE_STATEMENTS = new Set(['FunctionDeclaration', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'ExportAllDeclaration'])
const EFFECTS = new Set(['CallExpression', 'NewExpression', 'AwaitExpression', 'AssignmentExpression', 'UpdateExpression', 'TaggedTemplateExpression', 'ImportExpression', 'YieldExpression'])
const DEFERRED = new Set(['FunctionExpression', 'ArrowFunctionExpression'])

function effectIn(node) {
  if (node == null || typeof node.type !== 'string' || DEFERRED.has(node.type))
    return null
  if (EFFECTS.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete'))
    return node
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent')
      continue
    for (const child of Array.isArray(value) ? value : [value]) {
      const found = child != null && typeof child === 'object' ? effectIn(child) : null
      if (found !== null)
        return found
    }
  }
  return null
}

function importTimeEffect(statement) {
  if (statement.type === 'ImportDeclaration')
    return statement.specifiers.length === 0 ? statement : null
  if (SIDE_EFFECT_FREE_STATEMENTS.has(statement.type))
    return null
  if (statement.type === 'ExportNamedDeclaration')
    return statement.declaration == null ? null : importTimeEffect(statement.declaration)
  if (statement.type === 'ExportDefaultDeclaration')
    return SIDE_EFFECT_FREE_STATEMENTS.has(statement.declaration.type) ? null : effectIn(statement.declaration)
  if (statement.type === 'VariableDeclaration')
    return statement.declarations.map(declarator => effectIn(declarator.init)).find(effect => effect !== null) ?? null
  return statement
}

const noSideEffectsOnImport = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { effect: COMPOSITION_HAS_NO_IMPORT_SIDE_EFFECTS },
  },
  create(context) {
    return {
      Program(program) {
        for (const statement of program.body) {
          const effect = importTimeEffect(statement)
          if (effect !== null)
            context.report({ node: effect, messageId: 'effect' })
        }
      },
    }
  },
}

const compositionPlugin = { rules: { 'registers-only-in-composition': registersOnlyInComposition, 'no-side-effects-on-import': noSideEffectsOnImport } }

export const REGISTRATION_POLICY = [
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    ignores: [COMPOSITION_ROOT],
    plugins: { composition: compositionPlugin },
    rules: { 'composition/registers-only-in-composition': ['error', { anywhere: false }] },
  },
  {
    files: ['scripts/**/*.{ts,mts,cts,js,mjs,cjs}'],
    ignores: ['scripts/tests/**', COMPOSITION_ROOT],
    plugins: { composition: compositionPlugin },
    rules: { 'composition/registers-only-in-composition': ['error', { anywhere: true }] },
  },
  {
    files: [COMPOSITION_ROOT],
    plugins: { composition: compositionPlugin },
    rules: { 'composition/no-side-effects-on-import': 'error' },
  },
]

export const TABLE_NAME_CONSTANTS = {
  CARDS_ROLE: 'cards',
  DECISIONS_DIALOG: 'decisions',
  WATERMARKS: 'projection_watermarks',
  CARD_BODIES: 'card_bodies',
  HEARTBEATS: 'heartbeats',
  EVENTS_KIND: 'events',
  NODE_CURSORS: 'node_cursors',
  CARDS: 'cards',
  DECISIONS: 'decisions',
  OWNER_WAITS: 'owner_waits',
  DIRTY_ROWS: 'projection_dirty',
}
const TABLE_REFERENCE = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+(?:main\.)?([a-z_]\w*)\b/gi
const AN_UNRESOLVED_SPAN = '$…'
const NO_MODULE = 'no module'
const MODULE_OF_FILE = new Map(Object.entries(MODULE_FILES).flatMap(([module, files]) => files.map(file => [file, module])))

const A_TABLE_IS_READ_THROUGH_ITS_OWNER = 'SQL names {{table}}, a table {{owner}} owns, from a file of {{module}}: reach it through an operation of {{owner}}. Files that did so before this rule are listed in scripts/quality/foreign-table-sql-excepted.json, and that list only shrinks'

function sqlTextOf(node) {
  if (node.type === 'Literal')
    return typeof node.value === 'string' ? node.value : null
  return node.quasis.map((quasi, at) => {
    const span = node.expressions[at]
    const named = span?.type === 'Identifier' ? TABLE_NAME_CONSTANTS[span.name] : undefined
    return `${quasi.value.cooked ?? quasi.value.raw}${span === undefined ? '' : named ?? AN_UNRESOLVED_SPAN}`
  }).join('')
}

function moduleOfFile(filename) {
  return MODULE_OF_FILE.get(path.relative(ROOT, filename).split(path.sep).join('/')) ?? NO_MODULE
}

const noForeignTableSql = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { foreign: A_TABLE_IS_READ_THROUGH_ITS_OWNER },
  },
  create(context) {
    const fileModule = moduleOfFile(context.filename)
    const check = (node) => {
      const text = sqlTextOf(node)
      if (text === null)
        return
      for (const [, table] of text.matchAll(TABLE_REFERENCE)) {
        const owner = Object.hasOwn(TABLE_OWNERS, table) ? TABLE_OWNERS[table] : undefined
        if (owner !== undefined && owner !== fileModule)
          context.report({ node, messageId: 'foreign', data: { table, owner, module: fileModule } })
      }
    }
    return { Literal: check, TemplateLiteral: check }
  },
}

export const FOREIGN_TABLE_SQL_POLICY = [
  {
    files: ['scripts/**/*.{ts,mts,cts,js,mjs,cjs}', 'src/**/*.{ts,mts,cts,js,mjs,cjs}'],
    ignores: ['scripts/tests/**', 'tests/**', ...FOREIGN_TABLE_SQL_EXCEPTED],
    plugins: { tables: { rules: { 'no-foreign-table-sql': noForeignTableSql } } },
    rules: { 'tables/no-foreign-table-sql': 'error' },
  },
]

export default antfu(
  {
    isInEditor: false,
    typescript: true,
  },
  {
    ignores: ['dist/**', 'templates/*', '!templates/attach/', 'templates/attach/*', '!templates/attach/_construct/', '!.claude/', 'tests/fixtures/**', 'scripts/**/*.workflow.mjs', AGENT_WORKTREES, ...nestedWorktrees()],
  },
  ...dependencyBoundaries,
  doctorReadsThroughOneReader,
  intakeReadsDecisionsThroughTheirParser,
  boardTakesRolesAndVerdictsFromTheirOwners,
  attachDecidesWithoutTheStack,
  spawnPolicy,
  thePnpmProbeMaySpawnAndNothingElse,
  theGitReadingsMaySpawnAndNothingElse,
  theIntakeBashSyntaxCheckMaySpawnAndNothingElse,
  theRecordItselfMayReadBothHalves,
  theSurfaceTestNeverWrites,
  aHookReadsStdinToItsEnd,
  aTestWaitsOnAnEvent,
  anEventIsReadThroughTheContract,
  aSurfaceBoundaryIsGenerated,
  ...REGISTRATION_POLICY,
  ...FOREIGN_TABLE_SQL_POLICY,
)
