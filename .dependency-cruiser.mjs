const BUS_CORE = '^scripts/bus/(db|reducer|sqlite|stored|identifiers)\\.ts$'
const BUS_SERVICE = '^scripts/bus/([a-z]+)-(worker|executor|starter)\\.ts$'
const BUS_SERVICE_OF_SAME_NAME = '^scripts/bus/$1-(worker|executor|starter)\\.ts$'
const CORE = '^scripts/core/'
const FACTORY = '^(scripts/(bus|ghosts|shift|miko|decisions|lanes)/|src/commands/)'
const FORMER_EVENT_HOMES = '^src/commands/intake/(index|move)\\.ts$'
const LADDER = '^scripts/ghosts/'
const LADDER_STARTER = '^scripts/bus/ladder-starter\\.ts$'
const PORTS = '^scripts/ports/'
const PORT_CALLERS = '^scripts/(bus|ghosts|shift|miko)/'

export default {
  forbidden: [
    {
      name: 'bus-core-imports-no-service',
      severity: 'error',
      from: { path: BUS_CORE },
      to: { path: BUS_SERVICE },
    },
    {
      name: 'bus-services-import-no-other-service',
      severity: 'error',
      from: { path: BUS_SERVICE },
      to: { path: BUS_SERVICE, pathNot: BUS_SERVICE_OF_SAME_NAME },
    },
    {
      name: 'src-imports-no-script',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^scripts/', pathNot: CORE },
    },
    {
      name: 'core-imports-no-factory',
      severity: 'error',
      from: { path: CORE },
      to: { path: FACTORY },
    },
    {
      name: 'bus-imports-no-ladder',
      severity: 'error',
      from: { path: '^scripts/bus/', pathNot: LADDER_STARTER },
      to: { path: LADDER },
    },
    {
      name: 'ports-import-no-caller',
      severity: 'error',
      from: { path: PORTS },
      to: { path: PORT_CALLERS },
    },
    {
      name: 'bus-takes-event-names-from-core',
      severity: 'error',
      from: { path: '^scripts/bus/' },
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
