import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import buildConfig from '../tsup.config.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function lowestEngineMajor(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { engines: { node: string } }
  const lowest = /^>=\s*(\d+)/.exec(manifest.engines.node)
  if (lowest === null)
    throw new Error(`engines.node is not a lower bound: ${manifest.engines.node}`)
  return lowest[1]
}

describe('build target', () => {
  it('the tsup target matches the lowest node engines allows', async () => {
    expect(buildConfig).toMatchObject({ target: `node${await lowestEngineMajor()}` })
  })
})
