import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function subCommandLines(): string[] {
  const lines = read('src/program.ts').split('\n')
  const program = lines.findIndex(line => line.startsWith('export const main'))
  const opens = lines.findIndex((line, index) => index > program && line.includes('subCommands: {'))
  if (opens === -1)
    return []
  const rest = lines.slice(opens + 1)
  const closes = rest.findIndex(line => line.trim().startsWith('}'))
  return rest.slice(0, closes === -1 ? rest.length : closes)
}

function entries(): { name: string, aliasOf: string | null }[] {
  return subCommandLines()
    .map(line => line.trim().replace(/,$/, ''))
    .filter(line => line !== '' && !line.startsWith('//'))
    .map((line) => {
      const [name, target] = line.split(':').map(part => part.trim().replace(/^'(.*)'$/, '$1'))
      return { name, aliasOf: target == null || target === '' ? null : target }
    })
}

function registeredCommands(): string[] {
  return entries().filter(entry => entry.aliasOf == null).map(entry => entry.name).sort()
}

function aliases(): string[] {
  return entries().filter(entry => entry.aliasOf != null).map(entry => entry.name).sort()
}

describe('the front page lists what the tool can do', () => {
  const commands = registeredCommands()

  it('finds the commands the CLI registers, and tells an alias from a command', () => {
    expect(commands.length).toBeGreaterThan(3)
    expect(commands).toContain('sync')
    expect(commands).not.toContain('inspect')
    expect(aliases()).toEqual(['capture', 'inspect', 'jack-in', 'jack-out'])
  })

  it('names every alias where the command it stands for is documented', () => {
    const table = read('README.md')
    for (const alias of aliases())
      expect(table, alias).toContain(alias)
  })

  for (const command of commands) {
    it(`README names \`construct ${command}\` in its command table`, () => {
      expect(read('README.md')).toContain(`| \`construct ${command}\` |`)
    })

    it(`docs/cli.md documents \`construct ${command}\``, () => {
      expect(read('docs/cli.md')).toContain(`construct ${command}`)
    })
  }
})
