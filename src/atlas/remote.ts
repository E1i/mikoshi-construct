import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const BLOB_HOSTS = new Set(['github.com', 'gitlab.com'])
const PREFERRED_REMOTE = 'origin'
const SHA = /^[0-9a-f]{40}$/
const REPOSITORY_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/

interface GitDirs {
  git: string
  common: string
}

function readText(file: string): string | null {
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null
}

function gitDirsOf(root: string): GitDirs | null {
  const dotGit = path.join(root, '.git')
  if (!existsSync(dotGit))
    return null
  if (statSync(dotGit).isDirectory())
    return { git: dotGit, common: dotGit }
  const pointer = /^gitdir:\s*(\S.*)$/m.exec(readText(dotGit) ?? '')?.[1]?.trim()
  if (pointer == null)
    return null
  const git = path.resolve(root, pointer)
  const commondir = readText(path.join(git, 'commondir'))?.trim()
  return { git, common: commondir == null || commondir === '' ? git : path.resolve(git, commondir) }
}

function remoteUrls(config: string): Map<string, string> {
  const urls = new Map<string, string>()
  let remote: string | null = null
  for (const line of config.split('\n').map(entry => entry.trim())) {
    const section = /^\[(.+)\]$/.exec(line)?.[1]
    if (section != null) {
      remote = /^remote\s+"([^"]+)"$/.exec(section)?.[1] ?? null
      continue
    }
    const url = /^url\s*=\s*(\S+)$/.exec(line)?.[1]
    if (remote != null && url != null && !urls.has(remote))
      urls.set(remote, url)
  }
  return urls
}

function repositoryWeb(url: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url)
  const parsed = scp ?? /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url)
  if (parsed == null)
    return null
  const host = parsed[1]!.toLowerCase()
  const repository = parsed[2]!.replace(/\/+$/, '').replace(/\.git$/, '')
  return BLOB_HOSTS.has(host) && REPOSITORY_PATH.test(repository) ? `https://${host}/${repository}` : null
}

function packedRef(common: string, ref: string): string | null {
  const line = (readText(path.join(common, 'packed-refs')) ?? '').split('\n').find(entry => entry.endsWith(` ${ref}`))
  return line?.split(' ')[0] ?? null
}

function headSha(dirs: GitDirs): string | null {
  const head = readText(path.join(dirs.git, 'HEAD'))?.trim() ?? ''
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1]
  const sha = ref == null
    ? head
    : readText(path.join(dirs.git, ref))?.trim() ?? readText(path.join(dirs.common, ref))?.trim() ?? packedRef(dirs.common, ref)
  return sha != null && SHA.test(sha) ? sha : null
}

export function readRemoteBlob(root: string): string | null {
  const dirs = gitDirsOf(root)
  if (dirs == null)
    return null
  const urls = remoteUrls(readText(path.join(dirs.common, 'config')) ?? '')
  const url = urls.get(PREFERRED_REMOTE) ?? [...urls.values()][0]
  const web = url == null ? null : repositoryWeb(url)
  const sha = web == null ? null : headSha(dirs)
  return web == null || sha == null ? null : `${web}/blob/${sha}`
}
