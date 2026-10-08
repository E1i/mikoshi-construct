import { spawnSync } from 'node:child_process'
import process from 'node:process'

export type Notify = (title: string, message: string) => void

type Spawn = (command: string, args: string[]) => unknown

function appleScriptString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ')}"`
}

export function notificationScript(title: string, message: string): string {
  return `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`
}

export function osascriptNotify(platform: string = process.platform, spawn: Spawn = (command, args) => spawnSync(command, args, { stdio: 'ignore', timeout: 10_000 })): Notify {
  if (platform !== 'darwin')
    return () => {}
  return (title, message) => {
    try {
      spawn('osascript', ['-e', notificationScript(title, message)])
    }
    catch {}
  }
}
