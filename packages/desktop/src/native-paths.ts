/**
 * Where the platform library lives, and how it is copied out of the package.
 *
 * Two reasons the library is not loaded straight from `node_modules`:
 * - on Windows a loaded image cannot be replaced, and pnpm replaces an installed
 *   package by swapping its folder — the same failure the orb host already solved
 *   for koffi;
 * - a copy under the orb's data folder makes the shipped file disposable, so an
 *   update never has to win a fight with a running child.
 *
 * The helper binary stays beside the library: the macOS library finds it by
 * image path.
 * @module @dsh-orb/desktop/src/native-paths
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Pinned agent-desktop release. Must match `scripts/fetch-native.mjs`. */
export const NATIVE_VERSION = '1.2.0'

/** Platform keys the bundle ships. Anything else runs without desktop tools. */
export type NativeKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-arm64'

/** Library file name per platform. */
export function libraryName(key: NativeKey): string {
  if (key.startsWith('darwin')) return 'libagent_desktop_ffi.dylib'
  if (key.startsWith('win32')) return 'agent_desktop_ffi.dll'
  return 'libagent_desktop_ffi.so'
}

/** macOS-only companion the library looks for beside itself. */
export function helperName(key: NativeKey): string | undefined {
  return key.startsWith('darwin') ? 'agent-desktop-macos-helper' : undefined
}

/**
 * Platform key for a runtime pair.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the key, or undefined when the bundle ships no library for it.
 */
export function nativeKey(platform: string, arch: string): NativeKey | undefined {
  const key = `${platform}-${arch}`
  switch (key) {
    case 'darwin-arm64':
    case 'darwin-x64':
    case 'win32-x64':
    case 'win32-arm64':
      return key
    default:
      return undefined
  }
}

/**
 * The packaged folder that holds one platform's library.
 * @param key - platform key.
 * @param from - module URL of this file (defaults to import.meta.url).
 * @returns the folder, or undefined when the package contains no such folder.
 */
export function packagedNativeDir(key: NativeKey, from: string = import.meta.url): string | undefined {
  const bases = [new URL('./native/', from), new URL('../native/', from)]
  for (const base of bases) {
    const dir = join(fileURLToPath(base), key)
    if (existsSync(join(dir, libraryName(key)))) return dir
  }
  return undefined
}

/** Folder that holds the staged copies, under the orb's data folder. */
export function stageRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-orb', 'desktop', 'native')
}

/**
 * Copy one platform folder out of the package once, and return the copy.
 * A copy is only ever added, never rewritten: an older child may still have the
 * file mapped.
 * @param source - packaged folder.
 * @param key - platform key.
 * @returns folder holding the library and its helper.
 */
export function stageNative(source: string, key: NativeKey): string {
  const target = join(stageRoot(), `${NATIVE_VERSION}-${key}`)
  const library = join(target, libraryName(key))
  if (existsSync(library)) return target
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    if (!statSync(from).isFile()) continue
    copyFileSync(from, join(target, name))
  }
  writeFileSync(join(target, '.ready'), NATIVE_VERSION)
  return target
}