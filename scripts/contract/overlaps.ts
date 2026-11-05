import path from 'node:path'
import { findSites, siteLine } from './factory/overlaps.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

for (const site of findSites(REPO_ROOT))
  console.log(siteLine(site))
