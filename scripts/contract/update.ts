import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { generateSurface, renderSurface } from './surface.js'

const SURFACE_FILE = path.resolve(import.meta.dirname, '../../contract/surface.json')

writeFileSync(SURFACE_FILE, renderSurface(generateSurface()))
console.warn(`[contract] ${path.relative(process.cwd(), SURFACE_FILE)}`)
