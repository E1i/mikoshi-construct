import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busDirOf, machineBusPath } from '../core/bus-path.js'
import { messageOf } from '../core/errors.js'
import { FACTORY_RUNTIME } from '../core/factory-paths.js'
import { reportPath, treeReportPath } from '../core/places.js'

export const TECHNOLOGY_WORDS = ['https', 'shell'] as const

const PREFIX = '[tree-publish] '
const LAUNCH_DIR = 'launch'
const SOURCE_MODULE = '.ts'
export const TREE_PR_ENTRY = FACTORY_RUNTIME.shiftTreePr.replace(/\.ts$/, '')

export const HTTPS_ORIGIN_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'git@github.com:',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
  GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_2: '',
  GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_3: '!gh auth git-credential',
}

export function shellWord(text: string): string {
  return `'${text.replaceAll('\'', `'\\''`)}'`
}

export function treePrCommand(repo: string): string {
  return `pnpm --dir ${shellWord(repo)} --silent exec tsx ${FACTORY_RUNTIME.shiftTreePr}`
}

export function builtTreePr(entry: string): string {
  return `${shellWord(process.execPath)} ${shellWord(entry)}`
}

export function treePrOfThisBuild(repo: string, moduleUrl: string = import.meta.url): string {
  const extension = path.extname(moduleUrl)
  if (extension === SOURCE_MODULE)
    return treePrCommand(repo)
  return builtTreePr(path.join(fileURLToPath(new URL('../../', moduleUrl)), `${TREE_PR_ENTRY}${extension}`))
}

export function launchDirOf(home: string, busPath: string): string {
  const resolved = path.resolve(busPath)
  return resolved === machineBusPath(home) ? path.join(path.dirname(resolved), 'shift', LAUNCH_DIR) : path.join(busDirOf(resolved), LAUNCH_DIR)
}

export function restoreReport(saved: string, worktree: string): void {
  if (!existsSync(saved))
    return
  const tree = treeReportPath(worktree)
  mkdirSync(path.dirname(tree), { recursive: true })
  copyFileSync(saved, tree)
}

export function savedReportOf(launchDir: string, cardId: number): string {
  return reportPath(launchDir, String(cardId))
}

export function treePrPublisher(treePr: string, launchDir: string, env: NodeJS.ProcessEnv): (worktree: string, cardId: number) => void {
  return (worktree, cardId) => {
    try {
      execFileSync('sh', ['-c', `${treePr} ${cardId} ${shellWord(worktree)} ${shellWord(savedReportOf(launchDir, cardId))}`], { env: { ...env, ...HTTPS_ORIGIN_ENV }, stdio: 'ignore' })
    }
    catch (error) {
      console.error(`${PREFIX}card #${cardId}: tree-pr failed in ${worktree}, no pull request opened: ${messageOf(error)}`)
    }
  }
}

export function treeHoldsACommit(worktree: string, base: string): boolean {
  try {
    return Number(execFileSync('git', ['-C', worktree, 'rev-list', '--count', `${base}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) > 0
  }
  catch {
    return false
  }
}
