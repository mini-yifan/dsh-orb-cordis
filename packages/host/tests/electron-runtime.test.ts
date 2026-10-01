import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { expectedHash, PINNED_SHA256, releaseAssetUrls } from '../src/electron-runtime.ts'

const fileName = 'electron-v44.0.0-darwin-arm64.zip'

describe('Electron checksum pin', () => {
  it('accepts a checksum list that matches the pinned hash', () => {
    const pinned = PINNED_SHA256[fileName]
    assert.equal(expectedHash(`${pinned} *${fileName}\n`, fileName), pinned)
  })

  it('rejects a checksum list that disagrees with the pin', () => {
    const other = 'a'.repeat(64)
    assert.throws(
      () => expectedHash(`${other} *${fileName}\n`, fileName),
      /does not match the pinned hash/,
    )
  })

  it('rejects a file that was never pinned', () => {
    assert.throws(
      () => expectedHash(`${'b'.repeat(64)} *electron-v44.0.0-freebsd-x64.zip\n`, 'electron-v44.0.0-freebsd-x64.zip'),
      /no pinned Electron/,
    )
  })
})

describe('Electron release mirrors', () => {
  it('lists GitHub first and the npmmirror CDN second', () => {
    assert.deepEqual(releaseAssetUrls(fileName), [
      `https://github.com/electron/electron/releases/download/v44.0.0/${fileName}`,
      `https://cdn.npmmirror.com/binaries/electron/v44.0.0/${fileName}`,
    ])
  })

  it('covers SHASUMS256.txt on every mirror', () => {
    for (const url of releaseAssetUrls('SHASUMS256.txt')) {
      assert.match(url, /\/SHASUMS256\.txt$/)
    }
  })
})
