/**
 * Worker thread for the software echo canceller.
 *
 * The NLMS filter is too expensive for the CoreAudio callback. Keeping it here
 * means the capture and playback callbacks only copy a block and post it; the
 * filter can take a few milliseconds without causing an XRUN.
 */

import { parentPort } from 'node:worker_threads'
import { EchoCanceller } from './aec.ts'

type Request =
  | { type: 'active', active: boolean, anchor: number }
  | { type: 'reference', samples: ArrayBuffer }
  | { type: 'process', samples: ArrayBuffer, offset: number, length: number, startFrame: number }
  | { type: 'reset' }

const aec = new EchoCanceller({ filterLength: 256, stepSize: 0.02 })

parentPort?.on('message', (message: Request) => {
  if (message.type === 'active') {
    aec.setActive(message.active, message.anchor)
    return
  }
  if (message.type === 'reference') {
    aec.pushReference(new Float32Array(message.samples))
    return
  }
  if (message.type === 'reset') {
    aec.reset()
    return
  }
  const samples = new Float32Array(message.samples, message.offset, message.length)
  const cleaned = aec.process(samples, message.startFrame)
  const buffer = cleaned.buffer as ArrayBuffer
  parentPort?.postMessage({ type: 'cleaned', samples: buffer }, [buffer])
})
