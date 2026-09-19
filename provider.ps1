# WinTouch Bar - persistent PowerShell provider
# One long-lived process, commands sent as single lines on stdin:
#   GVO            -> get master volume (0-100)
#   SVO <n>        -> set master volume to n (0-100)
#   MUTE <0|1>     -> set mute
#   GBR            -> get brightness (or null when unsupported)
#   SBR <n>        -> set brightness n (0-100)
#   KEY <vk>       -> send a media/virtual key via keybd_event
#   MSTATE         -> get SMTC media session state (or null)
#   SEEK <seconds> -> arbitrary seek (not supported by Windows SMTC)
# Every reply is a single line prefixed with "@@WTB" followed by JSON.
$ErrorActionPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

$global:AsTaskGeneric = $null
$global:VolMode = 'auto'   # 'coreaudio' | 'fallback' | 'unavailable'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WTB {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
}
"@

# Volume driver: canonical Core Audio COM pattern (C#). Standard approach used
# by control tools - works on interactive Windows desktops. If this environment
# cannot expose IMMDevice (e.g. non-interactive session), falls back gracefully.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class VolumeControl {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator { int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice); }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice { int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface); }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
        int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out int c);
        int SetMasterVolumeLevel(float d, Guid g); int SetMasterVolumeLevelScalar(float f, Guid g);
        int GetMasterVolumeLevel(out float d); int GetMasterVolumeLevelScalar(out float f);
        int SetChannelVolumeLevel(uint i, float d, Guid g); int SetChannelVolumeLevelScalar(uint i, float f, Guid g);
        int GetChannelVolumeLevel(uint i, out float d); int GetChannelVolumeLevelScalar(uint i, out float f);
        int SetMute(bool b, Guid g); int GetMute(out bool b);
        int GetVolumeStepInfo(uint u, out uint s); int VolumeStepUp(Guid g); int VolumeStepDown(Guid g);
        int QueryHardwareSupport(uint u); int GetVolumeRange(out float min, out float max, out float step);
    }

    static IAudioEndpointVolume GetEndPoint() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) return null;
        var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        object epv;
        if (device.Activate(ref iid, 1, IntPtr.Zero, out epv) != 0) return null;
        return (IAudioEndpointVolume)epv;
    }

    public static int GetVolumeScalar() { try { var v = GetEndPoint(); if (v == null) return -1; float f; v.GetMasterVolumeLevelScalar(out f); return (int)Math.Round(f * 100); } catch { return -1; } }
    public static bool SetVolumeScalar(int pct) { try { var v = GetEndPoint(); if (v == null) return false; v.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, pct / 100f)), Guid.Empty); return true; } catch { return false; } }
    public static bool SetMute(bool mute) { try { var v = GetEndPoint(); if (v == null) return false; v.SetMute(mute, Guid.Empty); return true; } catch { return false; } }
    public static int GetMute() { try { var v = GetEndPoint(); if (v == null) return -1; bool m; v.GetMute(out m); return m ? 1 : 0; } catch { return -1; } }
}
"@

# Probe + warm: detect which volume path is usable.
function Update-WTBVolMode {
  if ($global:VolMode -eq 'unavailable') { return }
  $v = [VolumeControl]::GetVolumeScalar()
  if ($v -ge 0) { $global:VolMode = 'coreaudio' } else { $global:VolMode = 'fallback' }
}
Update-WTBVolMode

# WinRT helpers for SMTC media state (best-effort; guarded).
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  }
  if ($methods) { $global:AsTaskGeneric = $methods[0] }
} catch { }

function Await-WTBAsync {
  param($WinRtTask, $ResultType)
  if ($null -eq $global:AsTaskGeneric) { return $null }
  try {
    $asTask = $global:AsTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
  } catch { return $null }
}

function Get-WTBVolume {
  # VK_VOLUME_UP=0xAF, VK_VOLUME_DOWN=0xAE for the 'fallback' stepping path (not used here).
  $v = [VolumeControl]::GetVolumeScalar()
  if ($v -ge 0) { return $v }
  return $null
}

function Set-WTBVolume([int]$pct) {
  $ok = [VolumeControl]::SetVolumeScalar($pct)
  return [bool]$ok
}

function Set-WTBMute([bool]$mute) {
  $ok = [VolumeControl]::SetMute($mute)
  return [bool]$ok
}

function Get-WTBMute {
  $m = [VolumeControl]::GetMute()
  if ($m -lt 0) { return $false }
  return [bool]$m
}

# Step volume via media keys when Core Audio is unavailable (e.g. restricted session).
function Step-WTBVolume([int]$direction) {
  $steps = [Math]::Abs($direction)
  for ($i = 0; $i -lt $steps; $i++) {
    if ($direction -gt 0) { Invoke-WTBMediaKey 0xAF } else { Invoke-WTBMediaKey 0xAE }
    Start-Sleep -Milliseconds 20
  }
  return $true
}

function Get-WTBBrightness {
  try {
    $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue
  } catch { return $null }
  if ($null -ne $b) { return [int]$b.CurrentBrightness }
  return $null
}

function Set-WTBBrightness([int]$pct) {
  $clamped = [Math]::Max(0, [Math]::Min(100, $pct))
  try {
    $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue
  } catch { return $false }
  if ($null -eq $m) { return $false }
  try {
    $m.WmiSetBrightness(1, [uint32]$clamped) | Out-Null
    return $true
  } catch { return $false }
}

function Invoke-WTBMediaKey([int]$vk) {
  try {
    [WTB]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    [WTB]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  } catch { }
}
function Get-WTBMediaState {
  if ($null -eq $global:AsTaskGeneric) { return $null }
  try {
    $manager = Await-WTBAsync ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if ($null -eq $manager) { return $null }
    $session = $manager.GetCurrentSession()
    if ($null -eq $session) { return $null }
    $info = $session.GetPlaybackInfo()
    if ($null -eq $info) { return $null }
    $props = Await-WTBAsync ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.MediaProperties.MediaPlaybackProperties])
    $pos = [double]$session.GetPlaybackPosition().TotalSeconds
    $duration = [double]0
    $title = ''
    $artist = ''
    if ($null -ne $props) {
      if ($null -ne $props.Duration) { $duration = [double]$props.Duration.TotalSeconds }
      if ($null -ne $props.Title) { $title = [string]$props.Title }
      if ($null -ne $props.Artist) { $artist = [string]$props.Artist }
    }
    $status = $info.PlaybackStatus
    $playing = ($status -eq [Windows.Media.MediaPlaybackStatus]::Playing)
    if ($duration -le 0) { return $null }
    return @{
      title    = $title
      artist   = $artist
      position = [math]::Round($pos, 1)
      duration = [math]::Round($duration, 1)
      playing  = $playing
    }
  } catch { return $null }
}

function Send-WTBResult($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine('@@WTB' + $json)
}

# Ready signal (parent waits for this before sending commands).
[Console]::Out.WriteLine('@@WTBREADY')

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line -split ' '
  $cmd = $parts[0]
  try {
    switch ($cmd) {
      'GVO' {
        Send-WTBResult @{ ok = $true; op = 'GVO'; value = Get-WTBVolume }
      }
      'SVO' {
        $n = [int]$parts[1]
        $ok = Set-WTBVolume $n
        $v = Get-WTBVolume
        Send-WTBResult @{ ok = $ok; op = 'SVO'; value = $v }
      }
      'MUTE' {
        $m = ($parts[1] -eq '1')
        $ok = Set-WTBMute $m
        $cur = Get-WTBMute
        Send-WTBResult @{ ok = $ok; op = 'MUTE'; value = [bool]$cur }
      }
      'GBR' {
        $b = Get-WTBBrightness
        Send-WTBResult @{ ok = ($null -ne $b); op = 'GBR'; value = $b }
      }
      'SBR' {
        $n = [int]$parts[1]
        $ok = Set-WTBBrightness $n
        if ($ok) {
          Send-WTBResult @{ ok = $true; op = 'SBR'; value = $n }
        } else {
          $b = Get-WTBBrightness
          Send-WTBResult @{ ok = $false; op = 'SBR'; value = $b }
        }
      }
      'KEY' {
        Invoke-WTBMediaKey ([int]$parts[1])
        Send-WTBResult @{ ok = $true; op = 'KEY' }
      }
      'MSTATE' {
        $s = Get-WTBMediaState
        Send-WTBResult @{ ok = ($null -ne $s); op = 'MSTATE'; media = $s }
      }
      'SEEK' {
        Send-WTBResult @{ ok = $false; op = 'SEEK'; reason = 'SMTC does not expose arbitrary seek; requires a Comet/extension provider' }
      }
      'PING' {
        Send-WTBResult @{ ok = $true; op = 'PING' }
      }
      default {
        Send-WTBResult @{ ok = $false; op = 'UNKNOWN' }
      }
    }
  } catch {
    Send-WTBResult @{ ok = $false; op = $cmd; error = $_.Exception.Message }
  }
}