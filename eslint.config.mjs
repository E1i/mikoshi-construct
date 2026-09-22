import antfu from '@antfu/eslint-config'

const INTERNAL_MODULES = ['cli', 'commands', 'detect', 'manifest', 'materialize', 'model', 'presets', 'sync', 'ui', 'version']

const ALLOWED_INTERNAL_IMPORTS = {
  'src/detect': [],
  'src/manifest.ts': ['detect', 'materialize', 'presets'],
  'src/model': ['detect', 'presets'],
  'src/presets': ['detect'],
  'src/materialize': ['presets'],
  'src/sync': ['manifest', 'materialize', 'presets'],
  'src/ui': ['presets'],
  'src/failure.ts': ['ui'],
  'src/commands': ['detect', 'manifest', 'materialize', 'model', 'presets', 'sync', 'ui', 'version'],
  'src/cli.ts': ['commands', 'detect', 'presets', 'ui', 'version'],
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
        }],
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
      patterns: dependencyBoundary(['src/commands', ALLOWED_INTERNAL_IMPORTS['src/commands']]).rules['no-restricted-imports'][1].patterns,
      paths: [{ name: 'node:fs', importNames: ['readFileSync', 'readdirSync'], message: READS_GO_THROUGH_ONE_READER }],
    }],
  },
}

const ANTFU_RESTRICTED_SYNTAX = ['TSEnumDeclaration[const=true]', 'TSExportAssignment']

const SPAWNS_ONLY_THE_PNPM_PROBE = 'The CLI spawns nothing but `pnpm --version`, and only in src/detect/package-manager.ts'
const RUNS_ONLY_SHIPPED_CODE = 'The CLI runs only the code it ships: doctor audits a repository it does not trust, so src/ reads file text and never loads or runs code from it'

const NO_CHILD_PROCESS = [
  { selector: 'ImportDeclaration[source.value="node:child_process"]', message: SPAWNS_ONLY_THE_PNPM_PROBE },
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
  ignores: ['src/detect/package-manager.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_CHILD_PROCESS, ...NO_RUNTIME_CODE_LOADING, ...NO_BARE_INIT_RECORD],
  },
}

const theRecordItselfMayReadBothHalves = {
  files: ['src/manifest.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...NO_CHILD_PROCESS, ...NO_RUNTIME_CODE_LOADING],
  },
}

export default antfu(
  {
    isInEditor: false,
    typescript: true,
  },
  {
    ignores: ['dist/**', 'templates/**', 'tests/fixtures/**', 'scripts/**/*.workflow.mjs'],
  },
  ...dependencyBoundaries,
  doctorReadsThroughOneReader,
  spawnPolicy,
  theRecordItselfMayReadBothHalves,
)
