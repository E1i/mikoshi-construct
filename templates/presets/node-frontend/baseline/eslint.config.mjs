import antfu from '@antfu/eslint-config'

const CLASS_LIST_MUTATION = 'CallExpression[callee.object.property.name="classList"][callee.property.name=/^(add|remove|toggle|replace)$/]'
const INLINE_STYLE_WRITE = 'AssignmentExpression[left.object.property.name="style"]'
const INLINE_STYLE_PROPERTY = 'CallExpression[callee.object.property.name="style"][callee.property.name=/^(setProperty|removeProperty)$/]'

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
    ignores: ['**/dist/**', '**/node_modules/**', 'pnpm-lock.yaml'],
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
