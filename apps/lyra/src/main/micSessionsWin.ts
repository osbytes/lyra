/**
 * A PowerShell script that names the processes capturing audio on Windows, from WASAPI's
 * per-device audio sessions (IAudioSessionManager2 on every active capture endpoint). It prints
 * `apps:<process>,<process>` at start and on every change, and exits when Lyra (`parentPid`) does.
 *
 * Why this and not the privacy "consent store" in the registry: recent Windows 11 builds keep
 * that in a database (`PersistedInDatabase`) and stop updating the registry copy, so it no longer
 * shows who is on the mic. WASAPI sessions are the same data the volume mixer shows. PowerShell
 * and its C# compiler ship with Windows, so this needs no native addon; the C# compiles once.
 */
export function micSessionsScript(parentPid: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class LyraDeviceEnumerator {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILyraDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out ILyraDeviceCollection devices);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILyraDeviceCollection {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int Item(int index, out ILyraDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILyraDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILyraSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr group, int flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr group, int flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out ILyraSessionEnumerator sessions);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILyraSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out ILyraSessionControl2 session);
}

[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILyraSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr name);
  [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
  [PreserveSig] int GetIconPath(out IntPtr path);
  [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
  [PreserveSig] int GetGroupingParam(out Guid group);
  [PreserveSig] int SetGroupingParam(IntPtr group, IntPtr context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int GetSessionIdentifier(out IntPtr id);
  [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
  [PreserveSig] int GetProcessId(out uint pid);
}

public static class LyraMicSessions {
  const int CAPTURE = 1, ACTIVE_DEVICES = 1, SESSION_ACTIVE = 1, CLSCTX_ALL = 23;

  public static string Users() {
    var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
    var enumerator = (ILyraDeviceEnumerator)new LyraDeviceEnumerator();
    ILyraDeviceCollection devices;
    if (enumerator.EnumAudioEndpoints(CAPTURE, ACTIVE_DEVICES, out devices) < 0) return null;
    int count;
    devices.GetCount(out count);
    Guid iid = typeof(ILyraSessionManager2).GUID;
    for (int i = 0; i < count; i++) {
      ILyraDevice device;
      if (devices.Item(i, out device) < 0) continue;
      object activated;
      if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out activated) >= 0) {
        ILyraSessionEnumerator sessions;
        if (((ILyraSessionManager2)activated).GetSessionEnumerator(out sessions) >= 0) {
          int n;
          sessions.GetCount(out n);
          for (int j = 0; j < n; j++) {
            ILyraSessionControl2 session;
            if (sessions.GetSession(j, out session) < 0) continue;
            int state;
            uint pid;
            if (session.GetState(out state) >= 0 && state == SESSION_ACTIVE && session.GetProcessId(out pid) >= 0 && pid != 0) {
              try { names.Add(Process.GetProcessById((int)pid).ProcessName.Replace(",", "")); } catch (ArgumentException) {}
            }
            Marshal.ReleaseComObject(session);
          }
          Marshal.ReleaseComObject(sessions);
        }
        Marshal.ReleaseComObject(activated);
      }
      Marshal.ReleaseComObject(device);
    }
    Marshal.ReleaseComObject(devices);
    Marshal.ReleaseComObject(enumerator);
    return "apps:" + string.Join(",", names);
  }
}
'@
$last = $null
while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) {
  $line = [LyraMicSessions]::Users()
  if ($line -ne $null -and $line -ne $last) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    $last = $line
  }
  Start-Sleep -Milliseconds 1000
}
`
}
