// Prints "1" when any process is using the default audio input and "0" when none is,
// once at startup and then on every change. Lyra's main process reads these lines.
//
// Build: swiftc -O native/mac/micwatch.swift -o build/helpers/micwatch

import CoreAudio
import Foundation

func defaultInputDevice() -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var device = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device
  )
  return status == noErr && device != 0 ? device : nil
}

func isRunningSomewhere(_ device: AudioDeviceID) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var running = UInt32(0)
  var size = UInt32(MemoryLayout<UInt32>.size)
  let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running)
  return status == noErr && running != 0
}

setvbuf(stdout, nil, _IOLBF, 0)
var last: Bool? = nil

// Polling keeps this simple and follows default-device changes for free.
while true {
  let inUse = defaultInputDevice().map(isRunningSomewhere) ?? false
  if inUse != last {
    print(inUse ? "1" : "0")
    last = inUse
  }
  Thread.sleep(forTimeInterval: 1.0)
}
