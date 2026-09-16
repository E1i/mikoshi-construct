import antfu from '@antfu/eslint-config'

const INTERNAL_MODULES = ['cli', 'commands', 'detect', 'manifest', 'materialize', 'presets', 'ui', 'version']

const ALLOWED_INTERNAL_IMPORTS = {
  'src/detect': [],
  'src/presets': ['detect'],
  'src/materialize': ['presets'],
  'src/ui': ['presets'],
  'src/commands': ['detect', 'manifest', 'materialize', 'presets', 'ui', 'version'],
}

function dependencyBoundary([directory, allowed]) {
  const forbidden = INTERNAL_MODULES.filter(name => !allowed.includes(name))
  return {
    files: [`${directory}/**`],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: forbidden.flatMap(name => [`../${name}`, `../${name}.js`, `../${name}/*`]),
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
const NO_CHILD_PROCESS = {
  selector: 'ImportDeclaration[source.value="node:child_process"]',
  message: 'The CLI spawns nothing but `pnpm --version`, and only in src/detect/package-manager.ts',
}

const spawnPolicy = {
  files: ['src/**'],
  ignores: ['src/detect/package-manager.ts'],
  rules: { 'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, NO_CHILD_PROCESS] },
}

export default antfu(
  {
    isInEditor: false,
    typescript: true,
  },
  {
    ignores: ['dist/**', 'templates/**', 'tests/fixtures/**', 'scripts/construct/*.workflow.mjs'],
  },
  ...dependencyBoundaries,
  spawnPolicy,
)
