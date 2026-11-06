import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { generateFactory, renderFactory } from './factory.js'
import { generateSurface, renderSurface } from './surface.js'

const SURFACE_FILE = path.resolve(import.meta.dirname, '../../contract/surface.json')
const FACTORY_FILE = path.resolve(import.meta.dirname, '../../contract/factory.json')

writeFileSync(SURFACE_FILE, renderSurface(generateSurface()))
console.warn(`[contract] ${path.relative(process.cwd(), SURFACE_FILE)}`)
writeFileSync(FACTORY_FILE, renderFactory(generateFactory()))
console.warn(`[contract] ${path.relative(process.cwd(), FACTORY_FILE)}`)
