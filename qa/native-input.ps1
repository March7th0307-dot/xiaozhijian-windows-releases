param([Parameter(Mandatory=$true)][ValidateSet('focus','click','type','capture')][string]$Action,
      [int]$TargetPid=0,[int]$X=0,[int]$Y=0,[string]$Text='', [string]$File='')
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinInput {
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public UInt32 type; public UNION u; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public UInt32 mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public UInt16 wVk,wScan; public UInt32 dwFlags,time; public UIntPtr dwExtraInfo; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [DllImport("user32.dll", SetLastError=true)] public static extern UInt32 SendInput(UInt32 n, INPUT[] input, int size);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref POINT p);
 public static uint Mouse(uint flag) { var a=new INPUT[1]; a[0].type=0; a[0].u.mi.dwFlags=flag; return SendInput(1,a,Marshal.SizeOf(typeof(INPUT))); }
 public static uint Key(char c,bool up) { var a=new INPUT[1]; a[0].type=1; a[0].u.ki.wScan=(ushort)c; a[0].u.ki.dwFlags=4u | (up?2u:0u); return SendInput(1,a,Marshal.SizeOf(typeof(INPUT))); }
}
'@
if ($Action -eq 'capture') {
 Add-Type -AssemblyName System.Windows.Forms
 Add-Type -AssemblyName System.Drawing
 $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
 if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) { throw 'No interactive screen' }
 $bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
 $g=[System.Drawing.Graphics]::FromImage($bmp)
 try { $g.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size); $bmp.Save($File,[System.Drawing.Imaging.ImageFormat]::Png) }
 finally { $g.Dispose(); $bmp.Dispose() }
 @{capture=$File;width=$bounds.Width;height=$bounds.Height;interactive=[System.Environment]::UserInteractive}|ConvertTo-Json -Compress
 exit 0
}
$proc=Get-Process -Id $TargetPid -ErrorAction Stop
$proc.Refresh(); $hwnd=$proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw 'No native main window' }
[void][WinInput]::ShowWindow($hwnd,9)
[void][WinInput]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500
$foreground=[WinInput]::GetForegroundWindow()
$rect=New-Object WinInput+RECT
[void][WinInput]::GetWindowRect($hwnd,[ref]$rect)
$client=New-Object WinInput+POINT
[void][WinInput]::ClientToScreen($hwnd,[ref]$client)
if ($Action -eq 'focus') {
 @{pid=$TargetPid;hwnd=$hwnd.ToInt64();foreground=$foreground.ToInt64();same=($foreground -eq $hwnd);clientX=$client.X;clientY=$client.Y;left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom;interactive=[System.Environment]::UserInteractive}|ConvertTo-Json -Compress
 exit 0
}
if ($foreground -ne $hwnd) { throw 'Cannot focus app on interactive desktop; native input is unverified' }
if ($Action -eq 'click') {
 if ($X -lt $rect.Left -or $X -ge $rect.Right -or $Y -lt $rect.Top -or $Y -ge $rect.Bottom) { throw 'Click outside target window' }
 if (-not [WinInput]::SetCursorPos($X,$Y)) { throw 'Cannot move cursor' }
 Start-Sleep -Milliseconds 150
 $n=[WinInput]::Mouse(2)+[WinInput]::Mouse(4)
 if ($n -ne 2) { throw "Mouse SendInput accepted $n of 2" }
 @{mouseEvents=$n;x=$X;y=$Y}|ConvertTo-Json -Compress
 exit 0
}
if ($Action -eq 'type') {
 $n=0; foreach($ch in $Text.ToCharArray()){ $n += [WinInput]::Key($ch,$false); $n += [WinInput]::Key($ch,$true) }
 if ($n -ne ($Text.Length*2)) { throw "Keyboard SendInput accepted $n of $($Text.Length*2)" }
 @{keyboardEvents=$n;characters=$Text.Length}|ConvertTo-Json -Compress
}
