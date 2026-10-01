export type Sketch
  = | { kind: 'branch', branch: string, sha: string }
    | { kind: 'none', reason: string }

const SKETCH_PREFIX = 'Sketch: '
const BRANCH_AND_SHA = /^(\S+) @ ([0-9a-f]{40})$/
const NONE_AND_REASON = /^none — (\S.*)$/

export function parseSketch(implementText: string): Sketch {
  const line = implementText.split('\n')[1]
  if (line === undefined || !line.startsWith(SKETCH_PREFIX))
    throw new Error(`line 2 of the /implement text does not start with 'Sketch: ' (line 2 is ${JSON.stringify(line ?? '')})`)

  const value = line.slice(SKETCH_PREFIX.length)
  const branch = BRANCH_AND_SHA.exec(value)
  if (branch !== null)
    return { kind: 'branch', branch: branch[1], sha: branch[2] }

  const none = NONE_AND_REASON.exec(value)
  if (none !== null)
    return { kind: 'none', reason: none[1] }

  throw new Error(`the Sketch: line is neither '<branch> @ <40-hex sha>' nor 'none — <reason>' (${JSON.stringify(line)})`)
}

export function describeSketch(sketch: Sketch): string {
  return sketch.kind === 'branch'
    ? `from sketch ${sketch.branch} @ ${sketch.sha.slice(0, 7)}`
    : `clean tree (${sketch.reason})`
}
