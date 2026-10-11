import process from 'node:process'
import { RUN_ROOT_VARIABLE, RunRoot } from './run-root.js'

export default function setup(): (() => void) | undefined {
  if (process.env[RUN_ROOT_VARIABLE] !== undefined)
    return undefined
  const root = RunRoot.open()
  return () => {
    root.close()
  }
}
