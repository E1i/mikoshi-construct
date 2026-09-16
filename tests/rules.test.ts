import { describe, expect, it } from 'vitest'
import { cursorRuleTarget, isClaudeRule, mapRulesForTargets, parseClaudeRule, toCursorDiscoveryRule, toCursorRule } from '../src/materialize/rules.js'

const SCOPED = '---\npaths:\n  - "**/*.css"\n  - "**/*.vue"\n---\n\n# CSS\n\nModern CSS.\n'
const ALWAYS = '# Tests\n\n- Tests live in tests/.\n'

describe('parseClaudeRule', () => {
  it('reads paths from frontmatter and the description from the first heading', () => {
    expect(parseClaudeRule(SCOPED)).toEqual({ description: 'CSS', paths: ['**/*.css', '**/*.vue'], body: '# CSS\n\nModern CSS.\n' })
    expect(parseClaudeRule(ALWAYS)).toEqual({ description: 'Tests', paths: [], body: ALWAYS })
    expect(parseClaudeRule('---\ndescription: "Own words"\n---\nbody\n').description).toBe('Own words')
  })
})

describe('toCursorRule', () => {
  it('renders a path-scoped rule as auto-attached globs', () => {
    expect(toCursorRule(SCOPED)).toBe('---\ndescription: CSS\nglobs: **/*.css, **/*.vue\nalwaysApply: false\n---\n\n# CSS\n\nModern CSS.\n')
  })

  it('renders a rule without paths as always applied', () => {
    expect(toCursorRule(ALWAYS)).toBe(`---\ndescription: Tests\nalwaysApply: true\n---\n\n${ALWAYS}`)
  })
})

describe('mapRulesForTargets', () => {
  const files = new Map([['.claude/rules/tests.md', ALWAYS], ['.claude/rules/ui/css.md', SCOPED], ['CLAUDE.md', 'x']])

  it('recognizes rule files and mirrors their path under .cursor/rules', () => {
    expect(isClaudeRule('.claude/rules/tests.md')).toBe(true)
    expect(isClaudeRule('.claude/commands/plan.md')).toBe(false)
    expect(cursorRuleTarget('.claude/rules/ui/css.md')).toBe('.cursor/rules/ui/css.mdc')
  })

  it('keeps, mirrors or replaces the rules by AI target', () => {
    expect([...mapRulesForTargets(files, 'claude').keys()]).toEqual(['.claude/rules/tests.md', '.claude/rules/ui/css.md', 'CLAUDE.md'])
    expect([...mapRulesForTargets(files, 'cursor').keys()]).toEqual(['.cursor/rules/tests.mdc', '.cursor/rules/ui/css.mdc', 'CLAUDE.md'])
    expect([...mapRulesForTargets(files, 'both').keys()]).toEqual(['.claude/rules/tests.md', '.cursor/rules/tests.mdc', '.claude/rules/ui/css.md', '.cursor/rules/ui/css.mdc', 'CLAUDE.md'])
  })
})

describe('toCursorDiscoveryRule', () => {
  it('turns the Claude command into an agent-requested rule without command syntax', () => {
    const command = '---\ndescription: Discover this repository\nargument-hint: [area]\n---\n\nScope: `$ARGUMENTS` (empty means everything).\n'
    expect(toCursorDiscoveryRule(command)).toBe('---\ndescription: Discover this repository\nalwaysApply: false\n---\n\nScope: `what the user asked to (re)discover` (empty means everything).\n')
    expect([...mapRulesForTargets(new Map([['.claude/commands/construct-discover.md', command]]), 'cursor').keys()]).toEqual(['.cursor/rules/construct-discover.mdc'])
  })
})
