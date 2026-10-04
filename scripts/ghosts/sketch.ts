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

export type RangeDiffVerdict
  = | { ok: true }
    | { ok: false, reason: string }

export type GitRunner = (args: string[]) => string

const PAIR_LINE = /^ {0,3}(?:\d+|-):\s+(?:[0-9a-f]+|-+)\s+([=!<>])\s+(?:\d+|-):/

export function pairMarkers(rangeDiffOutput: string): string[] {
  return rangeDiffOutput.split('\n').flatMap((line) => {
    const marker = PAIR_LINE.exec(line)?.[1]
    return marker === undefined ? [] : [marker]
  })
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n').find(line => line.trim() !== '')?.trim() ?? 'no message'
}

export function rangeDiffVerdict(git: GitRunner, approved: string, launched: string, originMain: string): RangeDiffVerdict {
  const unable = (why: string): RangeDiffVerdict => ({ ok: false, reason: `git range-diff cannot compare the approved sketch ${approved.slice(0, 7)} with ${launched.slice(0, 7)} (${why}); re-approve the brief` })
  try {
    git(['cat-file', '-e', `${approved}^{commit}`])
  }
  catch {
    return unable(`${approved.slice(0, 7)} is not in the repository`)
  }
  try {
    const approvedBase = git(['merge-base', approved, originMain])
    const commits = Number(git(['rev-list', '--count', `${originMain}..${launched}`]))
    const markers = pairMarkers(git(['range-diff', '--no-color', '--no-patch', `${approvedBase}..${approved}`, `${originMain}..${launched}`]))
    if (commits > 0 && markers.length === commits && markers.every(marker => marker === '='))
      return { ok: true }
    return { ok: false, reason: `the sketch ${launched.slice(0, 7)} is not the approved ${approved.slice(0, 7)} rebased: git range-diff shows '${markers.join(' ')}' for ${commits} launched commits, not every one '='; re-approve the brief` }
  }
  catch (error) {
    return unable(firstLine(error))
  }
}
