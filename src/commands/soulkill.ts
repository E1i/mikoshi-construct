import type { DetectReport } from '../detect/index.js'
import type { Ui } from '../ui/console.js'

export const SOULKILL_EXIT = {
  reported: 0,
} as const

export const SOULKILL_JSON_SCHEMA_VERSION = 1

export function soulkillJson(report: DetectReport): Record<string, unknown> {
  return { schemaVersion: SOULKILL_JSON_SCHEMA_VERSION, ...report }
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

export function printDetectReport(ui: Ui, report: DetectReport): void {
  const layout = report.layout === 'monorepo' && report.monorepoTools.length > 0
    ? `monorepo (${report.monorepoTools.join(', ')})`
    : report.layout
  ui.tree([
    ['Directory', report.dir],
    ['CLI runtime', `Node.js ${report.nodeMajor} (the Node running construct, not read from this repository)`],
    ...(report.pnpmVersion == null ? [] : [['CLI pnpm', `pnpm ${report.pnpmVersion} (the pnpm on the PATH construct runs with, not read from this repository)`] as [string, string]]),
    ['Package manager', report.packageManager],
    ['Layout', layout],
    ['Workspace dirs', report.workspaceDirs.length > 0 ? `${report.workspaceDirs.join(', ')} (${report.workspacePackages.length} packages)` : 'none'],
    ['Other stacks\' manifests', report.existing.foreignManifests.length > 0 ? report.existing.foreignManifests.join(', ') : 'none'],
    ['src/', yesNo(report.hasSrc)],
    ['Contracts', report.existing.openapi ?? 'none'],
    ['tsconfig / ESLint config', `${yesNo(report.existing.tsconfig)} / ${yesNo(report.existing.eslintConfig)}`],
    ['GitHub workflows', yesNo(report.existing.githubWorkflows)],
    ['CLAUDE.md / AGENTS.md / .cursor/rules', `${yesNo(report.existing.claudeMd)} / ${yesNo(report.existing.agentsMd)} / ${yesNo(report.existing.cursorRules)}`],
    ['construct.json', yesNo(report.existing.constructJson)],
  ])
}
