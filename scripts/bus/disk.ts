import { statfsSync } from 'node:fs'
import process from 'node:process'

export const DISK_LOW = 'disk_low'

const GIB = 1024 ** 3

export const DISK_FLOOR_BYTES = 20 * GIB

export interface DiskBlocks {
  bavail: number
  bsize: number
}

export type DiskReader = () => DiskBlocks

export function statfsReader(dir: string = process.cwd()): DiskReader {
  return () => statfsSync(dir)
}

export function freeBytes(read: DiskReader): number {
  const { bavail, bsize } = read()
  return bavail * bsize
}

function gib(bytes: number): string {
  return (bytes / GIB).toFixed(1)
}

export function diskLowDetail(read: DiskReader): string | null {
  const free = freeBytes(read)
  return free >= DISK_FLOOR_BYTES ? null : `${gib(free)} GiB free, under the floor of ${gib(DISK_FLOOR_BYTES)} GiB`
}
