import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CI_ENVIRONMENT, inCiEnvironment } from '../nodes/witness/witness-worker.js'
import { foreignBusLines, packageOfBusProcess } from '../supervisor/supervisor.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OWN = '/home/owner/projects/mikoshi-construct'
const PROBE = '/var/folders/x/pack-live-1321.abc/prefix/lib/node_modules/mikoshi-construct'

describe('hygiene of the package and the bus processes', () => {
  it('package.json builds dist on pack, so npm pack never ships a stale build', () => {
    const scripts = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

    expect(scripts.prepack).toBe('pnpm build')
    expect(scripts.prepublishOnly).toBeUndefined()
  })

  it('the supervisor names a bus process from another package and leaves its own and foreign programs out', () => {
    const lines = foreignBusLines([
      { pid: 11, args: `node ${PROBE}/dist/scripts/supervisor/run.js` },
      { pid: 12, args: `node ${PROBE}/dist/scripts/nodes/witness/witness-worker.js --on` },
      { pid: 13, args: `node ${OWN}/dist/scripts/supervisor/run.js` },
      { pid: 14, args: 'node --import tsx scripts/supervisor/run.ts' },
      { pid: 15, args: 'node /elsewhere/dist/scripts/other/run.js' },
    ], `${OWN}/`)

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`pid 11 is a bus process from another package, ${PROBE}, not from ${OWN}`)
    expect(lines[1]).toContain('pid 12 is a bus process from another package')
  })

  it('reads the package root out of a built bus entry and nothing out of a source run', () => {
    expect(packageOfBusProcess(`node ${PROBE}/dist/scripts/supervisor/supervisor.js --supervise`)).toBe(PROBE)
    expect(packageOfBusProcess('pnpm --silent bus:run')).toBeNull()
  })

  it('the witness worker runs its commands in the CI environment', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin' }

    expect(inCiEnvironment(env)).toEqual({ PATH: '/bin', ...CI_ENVIRONMENT })
    expect(env.CI).toBe('true')
  })
})
