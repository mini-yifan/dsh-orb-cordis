/**
 * Put the unmodified upstream CLI on the child shell PATH.
 *
 * The background desktop preset drives `agent-desktop` exactly as its own
 * documentation describes: no wrapper, no guard, no ref book. This plugin only
 * makes the command exist: it stages the binary shipped inside the package into
 * the orb's data folder and prepends that folder to this process's PATH, so any
 * bash or pwsh child can call `agent-desktop` without the user configuring
 * anything.
 * @module @dsh-orb/desktop/src/cli-path
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { NATIVE_VERSION, cliName, nativeKey, packagedCliDir, type NativeKey } from './native-paths.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-orb-desktop-cli'

/** Folder holding this version's staged CLI. */
function stageDir(key: NativeKey): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-orb', 'bin', `${NATIVE_VERSION}-${key}`)
}

/**
 * Stage the CLI once and prepend it to PATH.
 * Never throws: a missing binary must not take the whole preset down.
 */
export function apply(): void {
  try {
    const key = nativeKey(process.platform, process.arch)
    if (key === undefined) {
      console.error(`dsh-orb: no agent-desktop build for ${process.platform}-${process.arch}`)
      return
    }
    const source = packagedCliDir(key)
    if (source === undefined) {
      console.error('dsh-orb: agent-desktop is missing from the package (run fetch-native before packing)')
      return
    }
    const target = stageDir(key)
    const binary = join(target, cliName(key))
    if (!existsSync(binary)) {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source)) {
        const from = join(source, entry)
        if (!statSync(from).isFile()) continue
        const to = join(target, entry)
        copyFileSync(from, to)
        if (!entry.endsWith('.exe')) execFileSync('chmod', ['755', to])
      }
    }
    const path = process.env.PATH ?? ''
    if (!path.split(delimiter).includes(target)) {
      process.env.PATH = `${target}${delimiter}${path}`
    }
  } catch (error) {
    console.error(`dsh-orb: agent-desktop staging failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
