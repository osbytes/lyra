// Reports who is using audio input, once at startup and then on every change. Lyra's main
// process reads these lines:
//   "apps:<bundle id>,<bundle id>"   macOS 14+: the apps capturing audio right now
//   "1" / "0"                        older macOS, or no app named: the default input is busy or not
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

func getUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value = UInt32(0)
  var size = UInt32(MemoryLayout<UInt32>.size)
  let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
  return status == noErr ? value : nil
}

// Bundle ids of the processes capturing audio input, from CoreAudio's process objects.
@available(macOS 14.0, *)
func inputBundleIDs() -> [String]? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  let system = AudioObjectID(kAudioObjectSystemObject)
  var size = UInt32(0)
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return nil }
  var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects) == noErr else {
    return nil
  }
  var ids = Set<String>()
  for object in objects where getUInt32(object, kAudioProcessPropertyIsRunningInput) ?? 0 != 0 {
    var bundleAddress = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyBundleID,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var bundle: Unmanaged<CFString>? = nil
    var bundleSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = withUnsafeMutablePointer(to: &bundle) { pointer in
      AudioObjectGetPropertyData(object, &bundleAddress, 0, nil, &bundleSize, pointer)
    }
    guard status == noErr, let value = bundle?.takeRetainedValue() else { continue }
    let id = value as String
    if !id.isEmpty && !id.contains(",") { ids.insert(id) }
  }
  return ids.sorted()
}

func report() -> String {
  let inUse = defaultInputDevice().map(isRunningSomewhere) ?? false
  if #available(macOS 14.0, *), let ids = inputBundleIDs(), !ids.isEmpty {
    return "apps:" + ids.joined(separator: ",")
  }
  return inUse ? "1" : "0"
}

setvbuf(stdout, nil, _IOLBF, 0)
var last: String? = nil

// Polling keeps this simple and follows default-device changes for free.
while true {
  let line = report()
  if line != last {
    print(line)
    last = line
  }
  Thread.sleep(forTimeInterval: 1.0)
}
