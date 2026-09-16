import antfu from '@antfu/eslint-config'

export default antfu(
  {
    isInEditor: false,
    typescript: true,
  },
  {
    ignores: ['dist/**', 'templates/**', 'tests/fixtures/**', 'scripts/construct/*.workflow.mjs'],
  },
)
