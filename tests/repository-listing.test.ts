import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { listing } from './repository-listing.js'

const LISTINGS_UNDER_CONCURRENT_WRITES = 300

const CHURN_OBJECT_DIRECTORIES = `
const { mkdirSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const objects = process.argv[1]
process.stdout.write('ready\\n')
for (let i = 0; ; i++) {
  const directory = path.join(objects, (i % 256).toString(16).padStart(2, '0'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'object'), '')
  rmSync(directory, { recursive: true, force: true })
}
`

function repository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-listing-'))
  mkdirSync(path.join(dir, 'src/nested'), { recursive: true })
  writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  writeFileSync(path.join(dir, 'src/nested/index.ts'), 'export {}\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const EXPECTED = ['README.md', 'src/', 'src/nested/', 'src/nested/index.ts']

async function churning(objects: string): Promise<() => Promise<void>> {
  const writer = spawn(process.execPath, ['-e', CHURN_OBJECT_DIRECTORIES, objects], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    writer.stdout.once('data', () => resolve())
    writer.once('error', reject)
  })
  return async () => {
    const exited = new Promise(resolve => writer.once('exit', resolve))
    writer.kill()
    await exited
  }
}

describe('listing a temporary repository', () => {
  it('lists the working tree with directories marked and nothing from .git', () => {
    expect(listing(repository())).toEqual(EXPECTED)
  })

  it('does not enter .git, so a directory there that cannot be read does not fail it', () => {
    const dir = repository()
    const sealed = path.join(dir, '.git/objects/72')
    mkdirSync(sealed)
    chmodSync(sealed, 0o000)
    try {
      expect(listing(dir)).toEqual(EXPECTED)
    }
    finally {
      chmodSync(sealed, 0o755)
    }
  })

  it('does not fail while another process creates and removes directories under .git/objects', async () => {
    const dir = repository()
    const stop = await churning(path.join(dir, '.git/objects'))
    try {
      for (let run = 0; run < LISTINGS_UNDER_CONCURRENT_WRITES; run++)
        expect(listing(dir)).toEqual(EXPECTED)
    }
    finally {
      await stop()
    }
  })
})
