import process from 'node:process'
import { stampLogOutput } from '../../bus/stamp.js'

stampLogOutput()
console.log('first line')
console.error('to stderr')
process.stdout.write(`env ${process.env.BUS_LOG_STAMP ?? 'cleared'}\n`)
process.stdout.write('no newline')
