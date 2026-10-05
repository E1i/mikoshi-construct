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
  = | { ok: true, regenerated?: string[] }
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

function excluding(paths: readonly string[]): string[] {
  return paths.length === 0 ? [] : ['--', '.', ...paths.map(file => `:!${file}`)]
}

function touchedPaths(git: GitRunner, paths: readonly string[], ranges: [string, string][]): string[] {
  const touched = new Set(ranges.flatMap(([from, to]) => git(['diff', '--name-only', from, to, '--', ...paths]).split('\n')))
  return paths.filter(file => touched.has(file))
}

export function rangeDiffVerdict(git: GitRunner, approved: string, launched: string, originMain: string, regenerated: readonly string[] = []): RangeDiffVerdict {
  const unable = (why: string): RangeDiffVerdict => ({ ok: false, reason: `git range-diff cannot compare the approved sketch ${approved.slice(0, 7)} with ${launched.slice(0, 7)} (${why}); re-approve the brief` })
  try {
    git(['cat-file', '-e', `${approved}^{commit}`])
  }
  catch {
    return unable(`${approved.slice(0, 7)} is not in the repository`)
  }
  try {
    const approvedBase = git(['merge-base', approved, originMain])
    const compare = (paths: readonly string[]): { commits: number, markers: string[], equal: boolean } => {
      const commits = Number(git(['rev-list', '--count', `${originMain}..${launched}`, ...excluding(paths)]))
      const markers = pairMarkers(git(['range-diff', '--no-color', '--no-patch', `${approvedBase}..${approved}`, `${originMain}..${launched}`, ...excluding(paths)]))
      return { commits, markers, equal: commits > 0 && markers.length === commits && markers.every(marker => marker === '=') }
    }
    const whole = compare([])
    if (whole.equal)
      return { ok: true }
    const reason = `the sketch ${launched.slice(0, 7)} is not the approved ${approved.slice(0, 7)} rebased: git range-diff shows '${whole.markers.join(' ')}' for ${whole.commits} launched commits, not every one '='`
    const touched = regenerated.length === 0 ? [] : touchedPaths(git, regenerated, [[approvedBase, approved], [originMain, launched]])
    if (touched.length === 0)
      return { ok: false, reason: `${reason}; re-approve the brief` }
    const outside = compare(touched)
    if (outside.equal)
      return { ok: true, regenerated: touched }
    return { ok: false, reason: `${reason}, and outside ${touched.join(', ')} it shows '${outside.markers.join(' ')}' for ${outside.commits}; re-approve the brief` }
  }
  catch (error) {
    return unable(firstLine(error))
  }
}
