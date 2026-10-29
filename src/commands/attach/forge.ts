import { remoteUrlOf } from '../../../scripts/core/bus-path.js'

export const FACTORY_FORGE_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com', 'ssh.github.com'])

const URL_WITH_SCHEME = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)/i
const SCP_LIKE_URL = /^(?:[^@/:]+@)?([^:/]+):(?!\/\/)/

export function remoteHostOf(url: string): string | null {
  const host = url.match(URL_WITH_SCHEME)?.[1] ?? url.match(SCP_LIKE_URL)?.[1]
  return host == null || host === '' ? null : host.toLowerCase()
}

export function hostWithoutFactory(root: string): string | null {
  const url = remoteUrlOf(root)
  const host = url == null ? null : remoteHostOf(url)
  return host == null || FACTORY_FORGE_HOSTS.has(host) ? null : host
}
