/**
 * Copy the self-contained Orb Mesh bundle from the sibling dsh-mesh checkout
 * into this package's vendor directory. The release boundary is the dsh-mesh
 * `@dsh-mesh/plugin` tarball; this script is the local-development equivalent.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = process.env.DSH_MESH_BUNDLE?.trim()
  || resolve(bundleRoot, '../../../dsh-mesh/packages/mesh-plugin/bundle')
const target = join(bundleRoot, 'vendor', 'mesh')

if (!existsSync(join(source, 'index.mjs'))) {
  throw new Error(`sync-mesh: ${source}/index.mjs is missing. Build @dsh-mesh/plugin first.`)
}
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(join(source, 'index.mjs'), join(target, 'index.mjs'))
await cp(join(source, 'device-agent.mjs'), join(target, 'device-agent.mjs'))
console.log(`sync-mesh: ${source} -> ${target}`)