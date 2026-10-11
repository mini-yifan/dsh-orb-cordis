/**
 * Native images (`.node`, `.dll`, `.exe`) and the in-app update on Windows.
 *
 * Under the desktop's Electron runtime (Node 24.18), deleting a link to a file
 * some process has mapped as a loaded image fails, and so does removing the
 * directory that holds it. The desktop runs pnpm on that runtime. pnpm replaces
 * an installed package by staging the new copy beside it (hard links into the
 * same store files) and deleting the old directory; while any process has
 * koffi's addon loaded from inside the package, both deletions fail with
 * `EPERM, Permission denied: \\?\…\dsh-orb_tmp_<pid>_<thread>\node_modules`
 * and the live package is left with files missing.
 *
 * So the host loads koffi from a copy outside the package (real files, new
 * inodes, one folder per koffi version), names it in {@link KOFFI_DIR_ENV} for
 * every loader in the bundle, and probes the package before an update asks pnpm
 * to replace it.
 */

import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The folder whose `node_modules` holds the koffi copy every loader in the bundle uses. */
export const KOFFI_DIR_ENV = 'DSH_ORB_KOFFI_DIR'

/** Written last into a copy, so a folder without it is a copy that never finished. */
const READY_MARKER = '.ready'

/** Leftover staging folders younger than this may belong to an install still running. */
const STALE_STAGE_MS = 10 * 60 * 1000

const IMAGE_EXTENSIONS = new Set(['.node', '.dll', '.exe'])

/**
 * Load koffi from the copy named in {@link KOFFI_DIR_ENV}, or beside `from` when there is none.
 * @param from - module URL the in-package fallback resolves from.
 */
export function requireKoffi<T>(from: string = import.meta.url): T {
  const dir = process.env[KOFFI_DIR_ENV]
  if (dir !== undefined && dir !== '') {
    try {
      return createRequire(join(dir, 'index.js'))('koffi') as T
    } catch (error) {
      console.error(`dsh-orb: koffi copy unusable, loading the packaged one: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return createRequire(from)('koffi') as T
}

/**
 * The installed package's root folder: `dist/host/index.js` sits two levels below it.
 * In the workspace this is `packages/`, which holds no `package.json`.
 */
export function ownPackageRoot(url: string = import.meta.url): string {
  return fileURLToPath(new URL('../../', url)).replace(/[\\/]+$/, '')
}

/**
 * Copy the package's koffi (and its platform prebuilds) to `cacheRoot/koffi-<version>`.
 * A finished copy is reused; a copy is only ever added, never rewritten, because an
 * older one may itself be mapped by a process that has not exited yet.
 * @returns the folder to name in {@link KOFFI_DIR_ENV}, or undefined when the package ships no koffi.
 */
export function stageKoffi(packageRoot: string, cacheRoot: string): string | undefined {
  const modules = join(packageRoot, 'node_modules')
  const manifest = join(modules, 'koffi', 'package.json')
  if (!existsSync(manifest)) return undefined
  const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version
  if (typeof version !== 'string' || !/^[\w.+-]+$/.test(version)) return undefined
  const target = join(cacheRoot, `koffi-${version}`)
  if (existsSync(join(target, READY_MARKER))) return target
  const partial = `${target}.partial-${process.pid}`
  rmSync(partial, { recursive: true, force: true })
  for (const entry of ['koffi', '@koromix']) {
    const from = join(modules, entry)
    if (existsSync(from)) cpSync(from, join(partial, 'node_modules', entry), { recursive: true, dereference: true })
  }
  writeFileSync(join(partial, READY_MARKER), '')
  try {
    renameSync(partial, target)
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    // Another process finished the same copy first.
    if (!existsSync(join(target, READY_MARKER))) throw error
  }
  return target
}

/**
 * Native images inside the package that some process holds mapped, which would make
 * pnpm's replace fail and leave the package half deleted. Each image is hard-linked into
 * a scratch folder beside the package; a folder whose removal fails holds a mapped one.
 * A scratch folder that cannot be removed is named like pnpm's own staging folders, so
 * {@link removeStaleStages} clears it once the mapping process is gone.
 * @returns the mapped images, relative to the package root; empty when nothing blocks a replace.
 */
export function mappedImages(packageRoot: string): string[] {
  const images = nativeImages(packageRoot)
  if (images.length === 0) return []
  const scratch = join(dirname(packageRoot), `${basename(packageRoot)}_tmp_probe_${process.pid}`)
  const mapped: string[] = []
  for (const [index, image] of images.entries()) {
    const dir = join(scratch, String(index))
    try {
      mkdirSync(dir, { recursive: true })
      linkSync(join(packageRoot, image), join(dir, 'image'))
    } catch {
      // No hard link here (another volume, a filesystem without links): nothing to learn.
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') mapped.push(image)
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // Still holds a link to a mapped image; the next start clears it.
  }
  return mapped
}

/** Every `.node`, `.dll`, and `.exe` file in the package tree, relative to its root. */
function nativeImages(packageRoot: string): string[] {
  const found: string[] = []
  const walk = (relative: string) => {
    let entries: string[]
    try {
      entries = readdirSync(join(packageRoot, relative))
    } catch {
      return
    }
    for (const entry of entries) {
      const path = relative === '' ? entry : join(relative, entry)
      let stat
      try {
        stat = lstatSync(join(packageRoot, path))
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(path)
      else if (IMAGE_EXTENSIONS.has(extension(entry))) found.push(path)
    }
  }
  walk('')
  return found
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Remove the `<name>_tmp_*` folders failed replaces left beside the package. They hold
 * hard links into the store, which the process that mapped them kept alive. Young ones
 * are left alone: they may belong to an install running right now.
 */
export function removeStaleStages(packageRoot: string, now: number = Date.now()): void {
  const parent = dirname(packageRoot)
  if (basename(parent) !== 'node_modules') return
  const prefix = `${basename(packageRoot)}_tmp_`
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const path = join(parent, entry)
    try {
      if (now - statSync(path).mtimeMs < STALE_STAGE_MS) continue
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Still mapped by a process that has not exited; a later start retries.
    }
  }
}
