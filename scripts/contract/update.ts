import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { GENERATED_FILES } from '../core/generated-files.js'
import { generateFactory, renderFactory } from './factory.js'
import { generateSurface, renderSurface } from './surface.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SURFACE_FILE = path.join(REPO_ROOT, GENERATED_FILES.surface.path)
const FACTORY_FILE = path.join(REPO_ROOT, GENERATED_FILES.factory.path)

writeFileSync(SURFACE_FILE, renderSurface(generateSurface()))
console.warn(`[contract] ${path.relative(process.cwd(), SURFACE_FILE)}`)
writeFileSync(FACTORY_FILE, renderFactory(generateFactory()))
console.warn(`[contract] ${path.relative(process.cwd(), FACTORY_FILE)}`)
