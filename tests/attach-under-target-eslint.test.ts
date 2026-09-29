import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import antfu from '@antfu/eslint-config'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const PLAIN_FLAT_CONFIG = 'export default [{ files: [\'**/*.{js,mjs}\'] }]\n'

const worlds: string[] = []

afterEach(() => {
  for (const dir of worlds.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function repositoryLintedByEslintDot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-eslint-'))
  worlds.push(dir)
  writeFileSync(path.join(dir, 'eslint.config.mjs'), PLAIN_FLAT_CONFIG)
  writeFileSync(path.join(dir, 'index.mjs'), 'export const ok = 1\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=a', 'add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-qm', 'import'], { cwd: dir })
  return dir
}

type Linter = (dir: string) => Promise<ESLint>

const LINTERS: { name: string, linter: Linter }[] = [
  { name: 'a plain flat config', linter: async dir => new ESLint({ cwd: dir, overrideConfigFile: path.join(dir, 'eslint.config.mjs') }) },
  { name: '@antfu/eslint-config', linter: async dir => new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: await antfu() }) },
]

async function errorsOfEslintDot(dir: string, linter: Linter): Promise<string[]> {
  const results = await (await linter(dir)).lintFiles(['.'])
  return results.flatMap(result => result.messages.filter(message => message.severity === 2).map(message => `${path.relative(dir, result.filePath)}: ${message.message}`))
}

describe('attach leaves a target repository that runs `eslint .` as green as it found it', () => {
  it.each(LINTERS)('adds no file that `eslint .` under $name reports as an error', async ({ linter }) => {
    const dir = repositoryLintedByEslintDot()
    expect(await errorsOfEslintDot(dir, linter)).toEqual([])

    const result = await runAttach(createUi(resolveTheme({ plain: true }), silentWriter), { dir, harness: 'npx eslint .', yes: true })

    expect(result.status).toBe('done')
    expect(await errorsOfEslintDot(dir, linter)).toEqual([])
  })
})
