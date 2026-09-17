const NO_CHILD_PROCESS = {
  selector: 'ImportDeclaration[source.value="node:child_process"]',
  message: 'The construct spawns no processes outside src/detect/package-manager.ts',
}

export default [
  {
    ignores: ['dist/**'],
  },
  {
    files: ['src/**'],
    rules: { 'no-restricted-syntax': ['error', NO_CHILD_PROCESS] },
  },
]
