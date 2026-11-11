import type { LawSite } from '../../nodes/laws.js'
import { Session } from 'node:inspector/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceOf } from '../../nodes/laws.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function repoPath(url: string): string | null {
  return url.startsWith('file://') ? path.relative(REPO_ROOT, fileURLToPath(url)) : null
}

export async function calledSources(run: () => unknown): Promise<Set<string>> {
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    await session.post('Profiler.takePreciseCoverage')
    await run()
    const { result } = await session.post('Profiler.takePreciseCoverage')
    await session.post('Profiler.stopPreciseCoverage')
    return new Set(result.filter(script => script.functions.some(fn => fn.functionName !== '' && (fn.ranges[0]?.count ?? 0) > 0)).flatMap((script) => {
      const file = repoPath(script.url)
      return file === null ? [] : [file]
    }))
  }
  finally {
    session.disconnect()
  }
}

export async function reachesSite(site: LawSite, run: () => unknown): Promise<boolean> {
  return (await calledSources(run)).has(sourceOf(site))
}
