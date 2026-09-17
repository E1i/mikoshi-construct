import process from 'node:process'
import { formatViolation, scanRepository } from './scan.js'

const violations = scanRepository()

if (violations.length > 0) {
  console.error(violations.map(formatViolation).join('\n'))
  process.exit(1)
}
