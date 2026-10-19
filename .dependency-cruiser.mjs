const BUS_CORE = '^scripts/bus/(db|reducer|sqlite|stored|identifiers)\\.ts$'
const BUS_SERVICE = '^scripts/bus/([a-z]+)-(worker|executor|starter)\\.ts$'
const BUS_SERVICE_OF_SAME_NAME = '^scripts/bus/$1-(worker|executor|starter)\\.ts$'

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
      to: { path: '^scripts/' },
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
