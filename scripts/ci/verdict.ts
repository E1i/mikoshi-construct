import type { Needs } from './required.js'
import process from 'node:process'
import { blockingJobs } from './required.js'

const blocking = blockingJobs(JSON.parse(process.env.NEEDS ?? '{}') as Needs)

if (blocking.length > 0) {
  console.error(`CI / required is red: ${blocking.join(', ')}`)
  process.exit(1)
}

console.log('CI / required is green.')
