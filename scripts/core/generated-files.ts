export interface GeneratedFile {
  path: string
  rebuild: readonly string[] | null
  check: readonly string[] | null
  rebuiltOnUpdate: boolean
  seamSources: readonly string[] | null
  followSources: readonly string[] | null
}

const EARLIER_CARRIERS_SCRIPT = 'scripts/attach/earlier-carriers.ts'
const CONTRACT_UPDATE = ['contract:update']
const REBUILD_EARLIER_CARRIERS = ['exec', 'tsx', EARLIER_CARRIERS_SCRIPT]
const CHECK_EARLIER_CARRIERS = [...REBUILD_EARLIER_CARRIERS, '--check']

export const GENERATED_FILES = {
  earlierCarriers: {
    path: 'templates/attach/earlier-carriers.json',
    rebuild: REBUILD_EARLIER_CARRIERS,
    check: CHECK_EARLIER_CARRIERS,
    rebuiltOnUpdate: true,
    seamSources: ['templates/ai', EARLIER_CARRIERS_SCRIPT],
    followSources: null,
  },
  surface: {
    path: 'contract/surface.json',
    rebuild: CONTRACT_UPDATE,
    check: null,
    rebuiltOnUpdate: true,
    seamSources: ['src/program.ts', 'scripts/contract'],
    followSources: ['src', 'templates', 'scripts/contract'],
  },
  factory: {
    path: 'contract/factory.json',
    rebuild: CONTRACT_UPDATE,
    check: null,
    rebuiltOnUpdate: true,
    seamSources: ['scripts', 'src'],
    followSources: ['scripts', 'src'],
  },
  composition: {
    path: 'architecture/composition/',
    rebuild: ['composition:render'],
    check: null,
    rebuiltOnUpdate: false,
    seamSources: null,
    followSources: null,
  },
  model: {
    path: 'architecture/model.md',
    rebuild: ['model:render'],
    check: null,
    rebuiltOnUpdate: false,
    seamSources: null,
    followSources: null,
  },
  addPopulation: {
    path: 'architecture/add-population.md',
    rebuild: null,
    check: null,
    rebuiltOnUpdate: false,
    seamSources: null,
    followSources: ['templates', 'src/presets', 'src/materialize'],
  },
  selfHostingDrift: {
    path: 'architecture/self-hosting-drift.yaml',
    rebuild: null,
    check: null,
    rebuiltOnUpdate: false,
    seamSources: null,
    followSources: ['templates'],
  },
  factoryManifest: {
    path: 'src/materialize/factory-manifest.ts',
    rebuild: null,
    check: null,
    rebuiltOnUpdate: false,
    seamSources: null,
    followSources: null,
  },
} as const satisfies Record<string, GeneratedFile>

export const RATCHET_FILE = {
  path: 'contract/ratchet.json',
  rebuild: ['exec', 'tsx', 'scripts/contract/ratchet.ts'],
} as const

const ROWS: readonly GeneratedFile[] = Object.values(GENERATED_FILES)

export const GENERATED_PATHS: readonly string[] = ROWS.map(row => row.path)

export const REBUILT_ON_UPDATE: readonly { path: string, rebuild: readonly string[] }[] = [
  ...ROWS.flatMap(row => row.rebuiltOnUpdate && row.rebuild !== null ? [{ path: row.path, rebuild: row.rebuild }] : []),
  RATCHET_FILE,
]

export const SHARED_APPEND_PATHS: readonly string[] = REBUILT_ON_UPDATE.map(row => row.path)

export const GENERATORS: readonly { path: string, command: string }[] = ROWS.flatMap(row => row.rebuild === null ? [] : [{ path: row.path, command: commandLine(row.rebuild) }])

export const REGENERATED: readonly { path: string, check: readonly string[] }[] = ROWS.flatMap(row => row.check === null ? [] : [{ path: row.path, check: row.check }])

export const SEAM_SOURCES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(ROWS.flatMap(row => row.seamSources === null ? [] : [[row.path, row.seamSources]]))

export function commandLine(args: readonly string[]): string {
  return `pnpm ${args.join(' ')}`
}

export function isRebuiltOnUpdate(file: string): boolean {
  return SHARED_APPEND_PATHS.includes(file)
}

export function rebuildsOf(files: readonly string[]): (readonly string[])[] {
  const selected = REBUILT_ON_UPDATE.filter(row => files.includes(row.path)).map(row => row.rebuild)
  return [...new Set(selected)]
}
