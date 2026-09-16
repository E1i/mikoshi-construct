import antfu from '@antfu/eslint-config'

const PROCESS_MEMBER = 'MemberExpression[object.name="process"]'
const RAW_REQUEST_DATA = 'MemberExpression[object.name="req"][property.name=/^(body|query|params)$/]'
const RAW_SQL = 'CallExpression[callee.object.name="sql"][callee.property.name="raw"]'

const NO_PROCESS_OUTSIDE_CONFIG = {
  selector: PROCESS_MEMBER,
  message: 'src touches process only in config.ts: read configuration through readConfig() and pass the value on',
}
const NO_RAW_REQUEST_DATA = {
  selector: RAW_REQUEST_DATA,
  message: 'External input is validated at the HTTP boundary: read req.body, req.query and req.params in a controller or middleware and pass values on',
}
const NO_RAW_SQL = {
  selector: RAW_SQL,
  message: 'SQL is never built from raw strings: interpolate tables and columns into the sql template instead of sql.raw',
}

function restrictSyntax(files, restrictions) {
  return { files, rules: { 'no-restricted-syntax': ['error', ...restrictions] } }
}

const ENVIRONMENT_READERS = ['src/config.ts', 'src/server.ts', 'src/scripts/**']
const HTTP_BOUNDARY = ['src/**/*.controller.ts', 'src/**/*.middleware.ts', 'src/http/**']

const dependencyPolicy = [
  restrictSyntax(['src/**'], [NO_RAW_SQL, NO_PROCESS_OUTSIDE_CONFIG, NO_RAW_REQUEST_DATA]),
  restrictSyntax(HTTP_BOUNDARY, [NO_RAW_SQL, NO_PROCESS_OUTSIDE_CONFIG]),
  restrictSyntax(ENVIRONMENT_READERS, [NO_RAW_SQL]),
]

export default antfu(
  {
    isInEditor: false,
    typescript: {
      tsconfigPath: './tsconfig.json',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'pnpm-lock.yaml', 'src/contracts/openapi.ts'],
  },
  ...dependencyPolicy,
  {
    files: ['src/server.ts', 'src/scripts/**'],
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
