import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { checkVersion, REGISTRY } from './registry.js'
import { STAGE_RECORD_FILE, stageIdFrom } from './stage.js'

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string, version: string }
const specifier = `${manifest.name}@${manifest.version}`
const onRegistry = await checkVersion({ packageName: manifest.name, version: manifest.version }, REGISTRY)

if (onRegistry === 'unreachable')
  throw new Error(`The registry could not be asked about ${specifier}, so whether to stage it is undetermined.`)

if (onRegistry !== 'absent') {
  console.log(`${specifier} is already on the registry; nothing to stage.`)
}
else {
  const stdout = execFileSync('npm', ['stage', 'publish', '--json', '--ignore-scripts', '--access', 'public', '--tag', 'latest'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  const stageId = stageIdFrom(stdout, manifest.name)
  writeFileSync(STAGE_RECORD_FILE, `${JSON.stringify({ version: manifest.version, stageId })}\n`)
  console.log(`${specifier} is staged as ${stageId} and awaits approval.`)
}
