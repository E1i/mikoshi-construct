import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const eslint = new ESLint({ cwd: root })

const HOOKS = ['.claude/hooks/turn-journal.mjs', 'templates/attach/_construct/commit-guard.mjs']

const SYNCHRONOUS_READS: Record<string, string> = {
  'readFileSync(0)': `import { readFileSync } from 'node:fs'\nexport const text = readFileSync(0, 'utf8')\n`,
  'fs.readFileSync(0)': `import fs from 'node:fs'\nexport const text = fs.readFileSync(0, 'utf8')\n`,
  'readFileSync of /dev/stdin': `import { readFileSync } from 'node:fs'\nexport const text = readFileSync('/dev/stdin', 'utf8')\n`,
  'readFileSync of process.stdin.fd': `import { readFileSync } from 'node:fs'\nimport process from 'node:process'\nexport const text = readFileSync(process.stdin.fd, 'utf8')\n`,
  'readSync(0, …)': `import { Buffer } from 'node:buffer'\nimport { readSync } from 'node:fs'\nexport const read = readSync(0, Buffer.alloc(1))\n`,
}

const READ_TO_ITS_END = `import { Buffer } from 'node:buffer'\nimport process from 'node:process'\n\nexport async function readInput() {\n  const chunks = []\n  for await (const chunk of process.stdin)\n    chunks.push(chunk)\n  return Buffer.concat(chunks).toString('utf8')\n}\n`

async function restricted(file: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: path.join(root, file) })
  return result.messages.filter(message => message.ruleId === 'no-restricted-syntax').map(message => message.message)
}

describe('a hook reads stdin to its end: the lint that holds the law', () => {
  for (const hook of HOOKS) {
    it(`lints ${hook} rather than ignoring it`, async () => {
      expect(await eslint.isPathIgnored(path.join(root, hook))).toBe(false)
    })

    for (const [name, source] of Object.entries(SYNCHRONOUS_READS)) {
      it(`refuses ${name} in ${hook}`, async () => {
        expect(await restricted(hook, source)).toEqual([expect.stringContaining('read stdin to its end')])
      })
    }

    it(`lets the read to the end through in ${hook}`, async () => {
      expect(await restricted(hook, READ_TO_ITS_END)).toEqual([])
    })
  }

  it('keeps a read of a named file outside hooks unrestricted', async () => {
    expect(await restricted('src/cli-sample.ts', SYNCHRONOUS_READS['readFileSync(0)'])).toEqual([])
  })
})
