import antfu from '@antfu/eslint-config'

const CLASS_LIST_ACCESS = ':matches([callee.object.property.name="classList"], [callee.object.property.value="classList"])'
const CLASS_LIST_METHOD = ':matches([callee.property.name=/^(add|remove|toggle|replace)$/], [callee.property.value=/^(add|remove|toggle|replace)$/])'
const CLASS_LIST_CALL = `CallExpression${CLASS_LIST_ACCESS}${CLASS_LIST_METHOD}`
const CLASS_LIST_BINDING = 'VariableDeclarator:matches([init.property.name="classList"], [init.property.value="classList"])'
const CLASS_LIST_MUTATION = `:matches(${CLASS_LIST_CALL}, ${CLASS_LIST_BINDING})`

const STYLE_ACCESS = ':matches([left.object.property.name="style"], [left.object.property.value="style"])'
const INLINE_STYLE_WRITE = `AssignmentExpression${STYLE_ACCESS}`
const STYLE_METHOD = ':matches([callee.property.name=/^(setProperty|removeProperty)$/], [callee.property.value=/^(setProperty|removeProperty)$/])'
const INLINE_STYLE_CALL = `CallExpression:matches([callee.object.property.name="style"], [callee.object.property.value="style"])${STYLE_METHOD}`
const STYLE_BINDING = 'VariableDeclarator:matches([init.property.name="style"], [init.property.value="style"])'
const INLINE_STYLE_PROPERTY = `:matches(${INLINE_STYLE_CALL}, ${STYLE_BINDING})`

const NO_STATE_CLASSES = {
  selector: CLASS_LIST_MUTATION,
  message: 'State crosses into CSS as a data-* or ARIA attribute; classes name things, never state',
}
const NO_INLINE_STYLES = {
  selector: `${INLINE_STYLE_WRITE}, ${INLINE_STYLE_PROPERTY}`,
  message: 'Scripts do not write inline styles: set a data-* attribute and let the stylesheet re-bind custom properties',
}

function restrictSyntax(files, ignores, restrictions) {
  return { files, ignores, rules: { 'no-restricted-syntax': ['error', ...restrictions] } }
}

const stylingPolicy = [
  restrictSyntax(['src/**'], [], [NO_STATE_CLASSES, NO_INLINE_STYLES]),
]

export default antfu(
  {
    isInEditor: false,
    typescript: {
      tsconfigPath: './tsconfig.json',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'pnpm-lock.yaml', 'scripts/construct/*.workflow.mjs'],
  },
  ...stylingPolicy,
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
