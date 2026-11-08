/**
 * Put the unmodified upstream CLI on the child shell PATH.
 *
 * This exists only for the raw test preset: it stages the upstream
 * `agent-desktop` binary (and its macOS helper) inside the orb's data folder and
 * prepends that folder to this process's PATH, so every bash tool can call
 * `agent-desktop` exactly as its own documentation describes. Nothing about the
 * binary is wrapped, filtered or guarded.
 * @module @dsh-orb/desktop/src/cli-path
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { NATIVE_VERSION, nativeKey, packagedNativeDir } from './native-paths.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-orb-desktop-cli'

/**
 * Stage the CLI once and prepend it to PATH.
 * Never throws: a missing binary must not take the whole preset down.
 */
export function apply(): void {
  try {
    const key = nativeKey(process.platform, process.arch)
    if (key === undefined) return
    const packaged = packagedNativeDir(key)
    if (packaged === undefined) {
      console.error('dsh-orb: desktop CLI is missing; run fetch-native before packing')
      return
    }
    const source = join(packaged, 'cli')
    if (!existsSync(source)) {
      console.error('dsh-orb: desktop CLI archive was not unpacked into native/<platform>/cli')
      return
    }
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const target = join(home, 'dsh-orb', 'bin', `${NATIVE_VERSION}-${key}`)
    if (!existsSync(join(target, 'agent-desktop'))) {
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
    console.error(`dsh-orb: desktop CLI staging failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
