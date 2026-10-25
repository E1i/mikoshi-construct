const BUS_CORE = '^scripts/core/(db|reducer|sqlite|stored|identifiers)\\.ts$'
const BUS_SERVICE = '^scripts/(?:nodes/[a-z]+|ladder)/([a-z]+)-(worker|executor|starter)\\.ts$'
const NODE = '^scripts/nodes/([^/]+)/'
const SAME_NODE = '^scripts/nodes/$1/'
const CORE_FILES_SRC_MAY_IMPORT = ['bus-path', 'eddies', 'events', 'factory-paths', 'gh-callers', 'handoff-dir', 'layer-map', 'merge-event', 'verification']
const SRC_MAY_IMPORT = [`^scripts/core/(${CORE_FILES_SRC_MAY_IMPORT.join('|')})\\.ts$`, '^scripts/owner/channel\\.ts$']
const COMMANDS = '^(scripts/owner/|src/commands/)'
const FORMER_EVENT_HOMES = '^src/commands/intake/(index|move)\\.ts$'
const LADDER = ['^scripts/ladder/', '^scripts/done/']

const CONTOURS = [
  { name: 'core', rank: 0, paths: ['^scripts/core/'] },
  { name: 'ports', rank: 1, paths: ['^scripts/ports/'] },
  { name: 'policy', rank: 2, paths: ['^scripts/policy/'] },
  { name: 'nodes', rank: 3, paths: ['^scripts/nodes/'] },
  { name: 'supervisor', rank: 4, paths: ['^scripts/supervisor/'] },
  { name: 'window', rank: 4, paths: ['^scripts/window/'] },
  { name: 'intake', rank: 4, paths: ['^scripts/intake/', '^src/card/', '^src/commands/intake/'] },
  { name: 'cli', rank: 5, paths: ['^scripts/cli/', '^src/commands/(board|cost)/', '^scripts/morse/cli\\.ts$'] },
]

const LADDER_IMPORTERS = CONTOURS.filter(contour => contour.name !== 'cli')
const FACTORY_SCRIPTS = CONTOURS.flatMap(contour => contour.paths).filter(path => path.startsWith('^scripts/'))

function pathsRightOf(contour) {
  return CONTOURS.filter(other => other.rank > contour.rank).flatMap(other => other.paths)
}

const nothingToTheRight = CONTOURS.filter(contour => pathsRightOf(contour).length > 0).map(contour => ({
  name: `${contour.name}-imports-nothing-to-its-right`,
  severity: 'error',
  from: { path: contour.paths },
  to: { path: pathsRightOf(contour) },
}))

export default {
  forbidden: [
    ...nothingToTheRight,
    {
      name: 'bus-core-imports-no-service',
      severity: 'error',
      from: { path: BUS_CORE },
      to: { path: BUS_SERVICE },
    },
    {
      name: 'ladder-imports-only-core-and-ports',
      severity: 'error',
      from: { path: LADDER },
      to: { path: CONTOURS.filter(contour => contour.rank > 1).flatMap(contour => contour.paths) },
    },
    {
      name: 'no-factory-contour-imports-ladder',
      severity: 'error',
      from: { path: LADDER_IMPORTERS.flatMap(contour => contour.paths) },
      to: { path: LADDER },
    },
    {
      name: 'nodes-import-no-other-node',
      severity: 'error',
      from: { path: NODE },
      to: { path: '^scripts/nodes/', pathNot: SAME_NODE },
    },
    {
      name: 'src-imports-no-script',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^scripts/', pathNot: SRC_MAY_IMPORT },
    },
    {
      name: 'core-imports-no-factory',
      severity: 'error',
      from: { path: '^scripts/core/' },
      to: { path: COMMANDS },
    },
    {
      name: 'takes-event-names-from-core',
      severity: 'error',
      from: { path: FACTORY_SCRIPTS },
      to: { path: FORMER_EVENT_HOMES, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-circular-bus-core',
      severity: 'error',
      from: { path: BUS_CORE },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
    },
  },
}
