import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const EXPECTED = 'daemon-fixture: substituted'
const [evidence] = process.argv.slice(2)
const consoleFile = path.join(evidence, 'console.json')
const heard = existsSync(consoleFile) ? readFileSync(consoleFile, 'utf8').match(/daemon-fixture: \w+/)?.[0] : undefined
if (heard === EXPECTED) {
  console.log(heard)
  process.exit(0)
}
console.log(heard ?? `no daemon-fixture line in ${consoleFile}`)
process.exit(1)
