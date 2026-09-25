import antfu from '@antfu/eslint-config'

const WORKSPACE_PACKAGES = ['@py-svc-assets/api', '@py-svc-assets/shared']

const ALLOWED_WORKSPACE_IMPORTS = {
  'apps/api': ['@py-svc-assets/shared'],
  'packages/shared': [],
}

const PROCESS_ENV_MEMBER = 'MemberExpression[object.name="process"][property.name="env"]'
const PROCESS_ENV_VIA_GLOBAL_THIS = 'MemberExpression[object.object.name="globalThis"][object.property.name="process"][property.name="env"]'
const PROCESS_ENV_DESTRUCTURED = 'VariableDeclarator[init.name="process"] > ObjectPattern > Property[key.name="env"]'
const PROCESS_ENV = `:matches(${PROCESS_ENV_MEMBER}, ${PROCESS_ENV_VIA_GLOBAL_THIS}, ${PROCESS_ENV_DESTRUCTURED})`

const PROCESS_MEMBER = 'MemberExpression[object.name="process"]'
const PROCESS_VIA_GLOBAL_THIS = 'MemberExpression[object.name="globalThis"]:matches([property.name="process"], [property.value="process"])'
const PROCESS_BINDING = 'VariableDeclarator[init.name="process"]'
const PROCESS = `:matches(${PROCESS_MEMBER}, ${PROCESS_VIA_GLOBAL_THIS}, ${PROCESS_BINDING})`

const RAW_REQUEST_MEMBER = 'MemberExpression[object.name="req"][property.name=/^(body|query|params)$/]'
const RAW_REQUEST_DESTRUCTURED = 'VariableDeclarator[init.name="req"] > ObjectPattern > Property[key.name=/^(body|query|params)$/]'
const RAW_REQUEST_ALIASED = 'VariableDeclarator[id.type="Identifier"][init.name="req"]'
const RAW_REQUEST_DATA = `:matches(${RAW_REQUEST_MEMBER}, ${RAW_REQUEST_DESTRUCTURED}, ${RAW_REQUEST_ALIASED})`

const RAW_SQL = 'MemberExpression[object.name="sql"]:matches([property.name="raw"], [property.value="raw"])'

const SHARED_SPECIFIER = '/^@py-svc-assets\\/shared(\\/|$)/'
const SHARED_IMPORT = `:matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration, ImportExpression)[source.value=${SHARED_SPECIFIER}]`
const SHARED_REQUIRE = `CallExpression[callee.name="require"][arguments.0.value=${SHARED_SPECIFIER}]`
const SHARED_MODULE = `:matches(${SHARED_IMPORT}, ${SHARED_REQUIRE})`

function dependencyBoundary([directory, allowed]) {
  const forbidden = WORKSPACE_PACKAGES.filter(name => !allowed.includes(name))
  return {
    files: [`${directory}/**`],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: forbidden.flatMap(name => [name, `${name}/*`]),
          message: allowed.length === 0
            ? `${directory} imports no other workspace package`
            : `${directory} may import only ${allowed.join(', ')}`,
        }],
      }],
    },
  }
}

const dependencyBoundaries = Object.entries(ALLOWED_WORKSPACE_IMPORTS)
  .filter(([, allowed]) => allowed.length < WORKSPACE_PACKAGES.length)
  .map(dependencyBoundary)

const NO_PROCESS_OUTSIDE_CONFIG = {
  selector: PROCESS,
  message: 'An app touches process only in config.ts: read configuration through readConfig() and pass the value on',
}
const NO_PROCESS_ENV_IN_PACKAGE = {
  selector: PROCESS_ENV,
  message: 'A package reads the environment only in its *.config.ts',
}
const NO_RAW_REQUEST_DATA = {
  selector: RAW_REQUEST_DATA,
  message: 'External input is validated at the HTTP boundary: read req.body, req.query and req.params in a controller or middleware and pass values on',
}
const NO_RAW_SQL = {
  selector: RAW_SQL,
  message: 'SQL is never built from raw strings: interpolate tables and columns into the sql template instead of sql.raw',
}
const NO_SHARED_OUTSIDE_CONTRACTS = {
  selector: SHARED_MODULE,
  message: 'Contract types enter an app only through src/contracts/types.ts: import them from there',
}

function restrictSyntax(files, restrictions) {
  return { files, rules: { 'no-restricted-syntax': ['error', ...restrictions] } }
}

const APP_ENVIRONMENT_READERS = ['apps/*/src/config.ts', 'apps/*/src/server.ts', 'apps/*/src/scripts/**']
const HTTP_BOUNDARY = ['apps/*/src/**/*.controller.ts', 'apps/*/src/**/*.middleware.ts', 'apps/*/src/http/**']
const CONTRACT_TYPES_GATEWAY = ['apps/*/src/contracts/**']
const PACKAGE_ENVIRONMENT_READERS = ['packages/*/src/*.config.ts']

const restrictedSyntax = [
  restrictSyntax(['apps/*/src/**'], [NO_RAW_SQL, NO_PROCESS_OUTSIDE_CONFIG, NO_RAW_REQUEST_DATA, NO_SHARED_OUTSIDE_CONTRACTS]),
  restrictSyntax(CONTRACT_TYPES_GATEWAY, [NO_RAW_SQL, NO_PROCESS_OUTSIDE_CONFIG, NO_RAW_REQUEST_DATA]),
  restrictSyntax(HTTP_BOUNDARY, [NO_RAW_SQL, NO_PROCESS_OUTSIDE_CONFIG, NO_SHARED_OUTSIDE_CONTRACTS]),
  restrictSyntax(APP_ENVIRONMENT_READERS, [NO_RAW_SQL, NO_SHARED_OUTSIDE_CONTRACTS]),
  restrictSyntax(['packages/*/src/**'], [NO_RAW_SQL, NO_PROCESS_ENV_IN_PACKAGE]),
  restrictSyntax(PACKAGE_ENVIRONMENT_READERS, [NO_RAW_SQL]),
]

export default antfu(
  {
    isInEditor: false,
    typescript: {
      tsconfigPath: './tsconfig.json',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'pnpm-lock.yaml', 'scripts/construct/*.workflow.mjs', 'packages/shared/src/api/openapi.ts', 'pyproject.toml'],
  },
  ...dependencyBoundaries,
  ...restrictedSyntax,
  {
    files: ['apps/*/src/server.ts', 'apps/*/src/scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'ts/no-unsafe-assignment': 'off',
      'ts/no-unsafe-call': 'off',
      'ts/no-unsafe-member-access': 'off',
      'ts/no-floating-promises': 'off',
    },
  },
)
