import antfu from '@antfu/eslint-config'

const INTERNAL_MODULES = ['cli', 'commands', 'detect', 'manifest', 'materialize', 'presets', 'sync', 'ui', 'version']

const ALLOWED_INTERNAL_IMPORTS = {
  'src/detect': [],
  'src/presets': ['detect'],
  'src/materialize': ['presets'],
  'src/sync': ['manifest', 'materialize', 'presets'],
  'src/ui': ['presets'],
  'src/commands': ['detect', 'manifest', 'materialize', 'presets', 'sync', 'ui', 'version'],
}

function dependencyBoundary([directory, allowed]) {
  const forbidden = INTERNAL_MODULES.filter(name => !allowed.includes(name))
  return {
    files: [`${directory}/**`],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: forbidden.flatMap(name => [`../${name}`, `../${name}.js`, `../${name}/*`, `../../${name}`, `../../${name}.js`, `../../${name}/*`]),
          message: allowed.length === 0
            ? `${directory} imports no other src module: it returns facts`
            : `${directory} may import only ${allowed.join(', ')}`,
        }],
      }],
    },
  }
}

const dependencyBoundaries = Object.entries(ALLOWED_INTERNAL_IMPORTS).map(dependencyBoundary)

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

const spawnPolicy = {
  files: ['src/**'],
  ignores: ['src/detect/package-manager.ts'],
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
  spawnPolicy,
)
