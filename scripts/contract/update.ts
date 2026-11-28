import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { GENERATED_FILES } from '../core/generated-files.js'
import { claudeAdapterWith } from '../ports/client/claude/adapter.js'
import { settingsFlag, shiftSettings } from '../ports/shift-settings.js'
import { generateFactory, renderFactory } from './factory.js'
import { withLaws } from './factory/laws.js'
import { generateSurface, renderSurface } from './surface.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SURFACE_FILE = path.join(REPO_ROOT, GENERATED_FILES.surface.path)
const FACTORY_FILE = path.join(REPO_ROOT, GENERATED_FILES.factory.path)
const client = claudeAdapterWith({ shiftSettings, settingsFlag })

writeFileSync(SURFACE_FILE, renderSurface(generateSurface()))
console.warn(`[contract] ${path.relative(process.cwd(), SURFACE_FILE)}`)
writeFileSync(FACTORY_FILE, renderFactory(withLaws(generateFactory({ id: client.id, isClient: client.processes.isClient }))))
console.warn(`[contract] ${path.relative(process.cwd(), FACTORY_FILE)}`)
