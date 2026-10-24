/// macOS system-output capture for the software AEC.
/// stdout is 48 kHz mono Float32 (the tap's native rate is reported on stderr).
/// stderr is one JSON event per line. stdin EOF stops the tap and exits 0.
import AudioToolbox
import CoreAudio
import Foundation

private let ringCapacity = 96_000
private let scratchFrames = 16_384

@main
enum SystemAudio {
  static func main() {
    if #available(macOS 14.2, *) {
      let engine = Engine()
      guard engine.start() else { exit(4) }
      while !FileHandle.standardInput.readData(ofLength: 4096).isEmpty {}
      engine.stop()
      exit(0)
    } else {
      fail(code: "unavailable", message: "system audio tap needs macOS 14.2 or newer")
    }
  }
}

private func fail(code: String, message: String) -> Never {
  emitError(code: code, message: message)
  exit(code == "unavailable" ? 4 : 5)
}

private func emitError(code: String, message: String) {
  fputs("{\"event\":\"error\",\"code\":\(jsonString(code)),\"message\":\(jsonString(message))}\n", stderr)
  fflush(stderr)
}

private func emitReady(rate: Double, channels: Int) {
  fputs("{\"event\":\"ready\",\"rate\":\(rate),\"channels\":\(channels),\"reference\":true}\n", stderr)
  fflush(stderr)
}

private func jsonString(_ text: String) -> String {
  var out = "\""
  for scalar in text.unicodeScalars {
    switch scalar {
    case "\\": out += "\\\\"
    case "\"": out += "\\\""
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if scalar.value < 0x20 {
        out += String(format: "\\u%04x", scalar.value)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  out += "\""
  return out
}

private func fourcc(_ value: OSStatus) -> String {
  let u = UInt32(bitPattern: value)
  let bytes = [UInt8((u >> 24) & 0xff), UInt8((u >> 16) & 0xff), UInt8((u >> 8) & 0xff), UInt8(u & 0xff)]
  let text = String(bytes: bytes, encoding: .ascii) ?? ""
  return text.isEmpty ? "\(value)" : "\(value) \(text)"
}

/// One producer (the audio callback) and one consumer (the stdout writer).
private final class Ring: @unchecked Sendable {
  private let samples = UnsafeMutablePointer<Float>.allocate(capacity: ringCapacity)
  private let writeIndex = AtomicInt64()
  private let readIndex = AtomicInt64()

  init() { samples.initialize(repeating: 0, count: ringCapacity) }

  func push(_ source: UnsafePointer<Float>, count: Int) {
    let write = writeIndex.load()
    let read = readIndex.load()
    let space = ringCapacity - Int(write - read) - 1
    let amount = min(count, max(0, space))
    if amount == 0 { return }
    let mask = Int64(ringCapacity - 1)
    for offset in 0..<amount {
      samples[Int((write + Int64(offset)) & mask)] = source[offset]
    }
    writeIndex.store(write + Int64(amount))
  }

  func pop(into destination: UnsafeMutablePointer<Float>, capacity: Int) -> Int {
    let write = writeIndex.load()
    let read = readIndex.load()
    let amount = min(capacity, Int(write - read))
    if amount <= 0 { return 0 }
    let mask = Int64(ringCapacity - 1)
    for offset in 0..<amount {
      destination[offset] = samples[Int((read + Int64(offset)) & mask)]
    }
    readIndex.store(read + Int64(amount))
    return amount
  }
}

private final class AtomicInt64: @unchecked Sendable {
  private var value: Int64 = 0

  func load() -> Int64 { OSAtomicAdd64Barrier(0, &value) }

  func store(_ next: Int64) {
    while true {
      let current = load()
      if OSAtomicCompareAndSwap64Barrier(current, next, &value) { return }
    }
  }
}

private final class Engine {
  private let ring = Ring()
  private let scratch: UnsafeMutablePointer<Float>
  private let devices = DispatchQueue(label: "dsh-orb-system-audio")
  private let writerStopped = DispatchSemaphore(value: 0)
  private let stopFlag = AtomicInt64()
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregate = AudioObjectID(kAudioObjectUnknown)
  private var ioProc: AudioDeviceIOProcID?
  private var rate: Double = 48_000
  private var channels = 2
  private var running = false
  private var writer: Thread?

  init() {
    scratch = .allocate(capacity: scratchFrames)
    scratch.initialize(repeating: 0, count: scratchFrames)
  }

  func start() -> Bool {
    if #available(macOS 14.2, *) {
      return devices.sync { openTap() }
    }
    return false
  }

  func stop() {
    devices.sync {
      guard running else { return }
      running = false
      if let ioProc {
        AudioDeviceStop(aggregate, ioProc)
        AudioDeviceDestroyIOProcID(aggregate, ioProc)
        self.ioProc = nil
      }
      if aggregate != kAudioObjectUnknown {
        AudioHardwareDestroyAggregateDevice(aggregate)
        aggregate = AudioObjectID(kAudioObjectUnknown)
      }
      if tapID != kAudioObjectUnknown {
        AudioHardwareDestroyProcessTap(tapID)
        tapID = AudioObjectID(kAudioObjectUnknown)
      }
    }
    stopFlag.store(1)
    writerStopped.wait()
  }

  @available(macOS 14.2, *)
  private func openTap() -> Bool {
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.name = "DSH Orb system audio"
    description.isPrivate = true
    description.muteBehavior = .unmuted
    var tap = AudioObjectID(kAudioObjectUnknown)
    var status = AudioHardwareCreateProcessTap(description, &tap)
    guard status == noErr else {
      emitError(code: "unavailable", message: "process tap: \(fourcc(status))")
      return false
    }
    tapID = tap

    let aggregateDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey: "DSH Orb system audio",
      kAudioAggregateDeviceUIDKey: "com.dsh.orb.system.\(UUID().uuidString)",
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]
      ],
      kAudioAggregateDeviceTapAutoStartKey: true,
    ]
    var aggregate = AudioObjectID(kAudioObjectUnknown)
    status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregate)
    guard status == noErr else {
      emitError(code: "unavailable", message: "aggregate tap: \(fourcc(status))")
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
      return false
    }
    self.aggregate = aggregate

    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamFormat,
      mScope: kAudioObjectPropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    status = AudioObjectGetPropertyData(aggregate, &address, 0, nil, &size, &format)
    guard status == noErr else {
      emitError(code: "failed", message: "tap format: \(fourcc(status))")
      cleanup()
      return false
    }
    guard format.mFormatID == kAudioFormatLinearPCM,
          (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0,
          format.mBitsPerChannel == 32 else {
      emitError(code: "failed", message: "tap is not Float32")
      cleanup()
      return false
    }
    rate = format.mSampleRate > 0 ? format.mSampleRate : 48_000
    channels = max(1, Int(format.mChannelsPerFrame))

    status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, nil) { [self] _, input, _, _, _ in
      self.read(input)
    }
    guard status == noErr, let ioProc else {
      emitError(code: "failed", message: "tap io: \(fourcc(status))")
      cleanup()
      return false
    }
    self.ioProc = ioProc
    status = AudioDeviceStart(aggregate, ioProc)
    guard status == noErr else {
      emitError(code: "failed", message: "tap start: \(fourcc(status))")
      cleanup()
      return false
    }
    running = true
    emitReady(rate: rate, channels: channels)
    let thread = Thread { [self] in self.writeLoop() }
    thread.name = "dsh-orb-system-audio.stdout"
    thread.start()
    writer = thread
    return true
  }

  private func cleanup() {
    if let ioProc {
      AudioDeviceDestroyIOProcID(aggregate, ioProc)
      self.ioProc = nil
    }
    if aggregate != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(aggregate)
      aggregate = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
  }

  /// Downmix the tap's interleaved or planar buffers to mono. The scratch
  /// buffer is only touched on the audio thread.
  private func read(_ input: UnsafePointer<AudioBufferList>?) {
    guard let input else { return }
    let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
    guard list.count > 0 else { return }
    let channelCount = max(1, channels)
    let frames: Int
    if list.count == 1, channelCount > 1 {
      guard let data = list[0].mData else { return }
      let floats = Int(list[0].mDataByteSize) / MemoryLayout<Float>.size
      frames = floats / channelCount
      guard frames > 0, frames <= scratchFrames else { return }
      let source = data.bindMemory(to: Float.self, capacity: floats)
      for frame in 0..<frames {
        var sum: Float = 0
        for channel in 0..<channelCount {
          sum += source[frame * channelCount + channel]
        }
        scratch[frame] = sum / Float(channelCount)
      }
    } else {
      guard list[0].mData != nil else { return }
      frames = Int(list[0].mDataByteSize) / MemoryLayout<Float>.size
      guard frames > 0, frames <= scratchFrames else { return }
      let planes = list.count
      for frame in 0..<frames { scratch[frame] = 0 }
      for buffer in list {
        guard let data = buffer.mData else { continue }
        let source = data.bindMemory(to: Float.self, capacity: frames)
        for frame in 0..<frames { scratch[frame] += source[frame] }
      }
      for frame in 0..<frames { scratch[frame] /= Float(planes) }
    }
    ring.push(scratch, count: frames)
  }

  private func writeLoop() {
    let buffer = UnsafeMutablePointer<Float>.allocate(capacity: 4096)
    defer { buffer.deallocate() }
    while true {
      let count = ring.pop(into: buffer, capacity: 4096)
      if count > 0 {
        let data = Data(bytes: buffer, count: count * MemoryLayout<Float>.size)
        FileHandle.standardOutput.write(data)
        continue
      }
      if stopFlag.load() != 0 { break }
      usleep(2_000)
    }
    writerStopped.signal()
  }
}
