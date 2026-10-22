import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import process from 'node:process'

const REFUSED = /EPERM|operation not permitted/i

function record(error) {
  const trace = process.env.SANDBOX_TRACE
  const refused = String(error instanceof Error ? error.message : error).split('\n').find(line => REFUSED.test(line))
  if (trace !== undefined && refused !== undefined)
    appendFileSync(trace, `${JSON.stringify({ file: process.env.SANDBOX_TRACE_FILE ?? '', test: process.env.SANDBOX_TRACE_TEST ?? '', refused: refused.trim() })}\n`)
}

process.on('uncaughtExceptionMonitor', record)

const { spawn, spawnSync } = childProcess
childProcess.spawnSync = (...args) => {
  const result = spawnSync(...args)
  if (result.error !== undefined)
    record(result.error)
  return result
}
childProcess.spawn = (...args) => {
  const child = spawn(...args)
  child.on('error', record)
  return child
}
syncBuiltinESMExports()
