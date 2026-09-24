import type { JsonSample } from '../../scripts/contract/json-samples.js'
import type { Surface } from '../../scripts/contract/surface.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tagCli, tagJsonKeys } from '../../scripts/contract/json-samples.js'
import { requiredChange } from '../../scripts/contract/semantic-diff.js'
import { fixtureSurface, reading } from './surface-fixture.js'

const FAKE_TAG_CLI = `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
const args = process.argv.slice(3)
const dir = args[args.indexOf('--dir') + 1]
if (args[0] === 'init') {
  mkdirSync(path.join(dir, 'architecture'), { recursive: true })
  writeFileSync(path.join(dir, 'architecture/principles.md'), '')
  writeFileSync(path.join(dir, 'construct.json'), '{}')
  process.exit(0)
}
if (args[0] === 'doctor' && !existsSync(path.join(dir, 'construct.json'))) {
  process.stdout.write('TypeError: cannot read properties of null')
  process.exit(1)
}
process.stdout.write(JSON.stringify({ ok: true }))
`

describe('a JSON pair the tag cannot be sampled for', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'construct-fake-tag-'))
    mkdirSync(path.join(root, 'node_modules/tsx/dist'), { recursive: true })
    mkdirSync(path.join(root, 'src'))
    writeFileSync(path.join(root, 'node_modules/tsx/dist/cli.mjs'), FAKE_TAG_CLI)
    writeFileSync(path.join(root, 'src/cli.ts'), '')
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('is unbaselined at the level of that pair, names its command and state, and reads breaking', () => {
    const observed = tagJsonKeys(tagCli(root))
    const sampledOk = observed.doctor.ok as JsonSample
    const head: Surface = { ...fixtureSurface(), jsonKeys: { doctor: { ok: sampledOk, notOk: sampledOk, noManifest: { root: 'object', keys: ['schemaVersion'] } } } }
    const base = { ...reading(fixtureSurface()), jsonKeys: { doctor: observed.doctor } }
    expect(requiredChange(base, head)).toEqual({
      level: 'breaking',
      reasons: ['jsonKeys.doctor.noManifest: unbaselined in the base (doctor noManifest could not be observed from the tag: doctor noManifest: the sample exited 1 and printed no JSON), so it counts as changed'],
    })
    expect(observed.doctor.ok).toEqual({ root: 'object', keys: ['ok'] })
    expect(observed.doctor.notOk).toEqual({ root: 'object', keys: ['ok'] })
  }, 60_000)
})
