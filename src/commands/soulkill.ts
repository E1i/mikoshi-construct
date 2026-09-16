import type { DetectReport } from '../detect/index.js'
import type { Ui } from '../ui/console.js'

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

export function printDetectReport(ui: Ui, report: DetectReport): void {
  const layout = report.layout === 'monorepo' && report.monorepoTools.length > 0
    ? `monorepo (${report.monorepoTools.join(', ')})`
    : report.layout
  ui.tree([
    ['Directory', report.dir],
    ['Runtime', `Node.js ${report.nodeMajor}`],
    ['Package manager', report.pnpmVersion == null ? report.packageManager : `${report.packageManager} (pnpm ${report.pnpmVersion} installed)`],
    ['Layout', layout],
    ['Workspace dirs', report.workspaceDirs.length > 0 ? `${report.workspaceDirs.join(', ')} (${report.workspacePackages.length} packages)` : 'none'],
    ['src/', yesNo(report.hasSrc)],
    ['Contracts', report.existing.openapi ?? 'none'],
    ['tsconfig / ESLint config', `${yesNo(report.existing.tsconfig)} / ${yesNo(report.existing.eslintConfig)}`],
    ['GitHub workflows', yesNo(report.existing.githubWorkflows)],
    ['CLAUDE.md / AGENTS.md / .cursor/rules', `${yesNo(report.existing.claudeMd)} / ${yesNo(report.existing.agentsMd)} / ${yesNo(report.existing.cursorRules)}`],
    ['construct.json', yesNo(report.existing.constructJson)],
  ])
}
