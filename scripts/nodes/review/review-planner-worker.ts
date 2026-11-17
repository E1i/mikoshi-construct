import process from 'node:process'
import { planLeaseOnStdin } from './review-worker.js'

process.exitCode = await planLeaseOnStdin(process.cwd(), process.argv.slice(2))
