import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const eslint = new ESLint({ cwd: process.cwd() })

async function reports(file: string, source: string): Promise<boolean> {
  const [result] = await eslint.lintText(source, { filePath: file })
  return result.messages.some(message => message.ruleId === 'no-restricted-syntax')
}

describe('syntax policy by file role', () => {
  it('reports a child process import from src', async () => {
    expect(await reports('src/detect/spawn.ts', 'import { execFileSync } from \'node:child_process\'\n\nexport const probe = execFileSync\n')).toBe(true)
  })
})
