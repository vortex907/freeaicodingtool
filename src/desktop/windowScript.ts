// PowerShell (Windows PowerShell 5.1) that lists, captures and drives desktop windows through Win32 and
// UI Automation. Arguments arrive as JSON in $env:FC_ARGS; the result is one JSON object on stdout.
// Written without backticks and dollar-brace sequences so it can live in a template literal.

export const WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$a = $env:FC_ARGS | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
if (-not ('FcWin' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FcWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  // WM_GETTEXT and WM_SETTEXT work across processes for standard controls (GetWindowText does not).
  public static string Text(IntPtr h) { var sb = new StringBuilder(8192); SendMessage(h, 0x000D, (IntPtr)8192, sb); return sb.ToString(); }
  public static void SetText(IntPtr h, string t) { SendMessage(h, 0x000C, IntPtr.Zero, t); }
  public static void Click(int x, int y) { SetCursorPos(x, y); mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> TopWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => { if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }
}
"@
}

# Physical pixels everywhere (screenshots, UI Automation rectangles, mouse clicks) at any display scaling.
[void][FcWin]::SetProcessDPIAware()

# Classic Win32 and .NET Framework WinForms controls often show up as plain "Pane": use the window class.
function Get-Kind($c) {
  $type = $c.ControlType.ProgrammaticName.Replace('ControlType.', '')
  $cls = [string]$c.ClassName
  if ($type -eq 'Pane' -and $cls) {
    if ($cls -match 'BUTTON') { return 'Button' }
    if ($cls -match 'RICHEDIT|EDIT') { return 'Edit' }
    if ($cls -match 'STATIC') { return 'Text' }
    if ($cls -match 'COMBOBOX') { return 'ComboBox' }
    if ($cls -match 'LISTBOX|SysListView32') { return 'List' }
    if ($cls -match 'SysTreeView32') { return 'Tree' }
    if ($cls -match 'trackbar') { return 'Slider' }
    if ($cls -match 'progress') { return 'ProgressBar' }
    if ($cls -match 'SysTabControl32') { return 'Tab' }
  }
  return $type
}

function Get-Windows {
  $out = @()
  foreach ($h in [FcWin]::TopWindows()) {
    $title = [FcWin]::Title($h)
    if (-not $title) { continue }
    $r = [FcWin]::Bounds($h)
    $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
    if ($w -lt 60 -or $hh -lt 40) { continue }
    [uint32]$procId = 0
    [void][FcWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $name = ''
    try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    $out += [pscustomobject]@{ hwnd = [int64]$h; title = $title; pid = [int]$procId; process = $name; x = $r.Left; y = $r.Top; width = $w; height = $hh }
  }
  return $out
}

function Find-Window {
  $all = Get-Windows
  $hit = $null
  if ($a.pid) { $hit = $all | Where-Object { $_.pid -eq [int]$a.pid } | Select-Object -First 1 }
  if (-not $hit -and $a.pid) {
    # dotnet run, npm start and friends start the real app as a child process.
    $kids = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + [int]$a.pid) -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.ProcessId })
    $hit = $all | Where-Object { $kids -contains $_.pid } | Select-Object -First 1
  }
  if (-not $hit -and $a.title) { $hit = $all | Where-Object { $_.title -like ('*' + $a.title + '*') } | Select-Object -First 1 }
  if (-not $hit -and $a.process) { $hit = $all | Where-Object { $_.process -like $a.process.Replace('.exe', '') } | Select-Object -First 1 }
  return $hit
}

function Get-Tree($win) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$win.hwnd)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $nodes = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($root, 0))
  while ($stack.Count -gt 0 -and $nodes.Count -lt 400) {
    $item = $stack.Pop(); $e = $item[0]; $d = $item[1]
    try {
      $c = $e.Current
      $r = $c.BoundingRectangle
      $value = $null
      try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $value = $vp.Current.Value } catch {}
      $toggle = $null
      try { $tp = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $toggle = [string]$tp.Current.ToggleState } catch {}
      $kind = Get-Kind $c
      if ($value -eq $null -and $kind -eq 'Edit' -and $c.NativeWindowHandle) { $value = [FcWin]::Text([IntPtr]$c.NativeWindowHandle) }
      $node = [ordered]@{ depth = $d; type = $kind; name = $c.Name; id = $c.AutomationId; enabled = $c.IsEnabled; offscreen = $c.IsOffscreen }
      if (-not $r.IsEmpty) { $node.x = [int]($r.X - $win.x); $node.y = [int]($r.Y - $win.y); $node.w = [int]$r.Width; $node.h = [int]$r.Height }
      if ($value -ne $null) { $node.value = [string]$value }
      if ($toggle) { $node.toggle = $toggle }
      [void]$nodes.Add($node)
      if ($d -lt 10) {
        $kids = @()
        $k = $walker.GetFirstChild($e)
        while ($k -ne $null -and $kids.Count -lt 150) { $kids += $k; $k = $walker.GetNextSibling($k) }
        for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($d + 1))) }
      }
    } catch {}
  }
  return $nodes
}

function Find-Element($win, $target) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$win.hwnd)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $exact = $null; $loose = $null
  foreach ($e in $all) {
    $c = $e.Current
    if ($c.AutomationId -eq $target -or $c.Name -eq $target) { if (-not $exact) { $exact = $e }; if ((Get-Kind $c) -eq 'Button') { return $e } }
    elseif (-not $loose -and $c.Name -and $c.Name -like ('*' + $target + '*')) { $loose = $e }
  }
  if ($exact) { return $exact }
  if ($loose) { return $loose }
  # "Edit", "Edit 2", "TextBox", "Button#3": the Nth control of that kind (when controls have no names).
  if ($target -match '^\s*([A-Za-z]+)\s*#?\s*(\d*)\s*$') {
    $kind = $matches[1]; $n = 1
    if ($matches[2]) { $n = [int]$matches[2] }
    $aliases = @{ textbox = 'Edit'; input = 'Edit'; field = 'Edit'; label = 'Text'; checkbox = 'CheckBox'; dropdown = 'ComboBox'; combobox = 'ComboBox'; list = 'List'; slider = 'Slider' }
    if ($aliases.ContainsKey($kind.ToLower())) { $kind = $aliases[$kind.ToLower()] }
    $i = 0
    foreach ($e in $all) {
      if ((Get-Kind $e.Current) -eq $kind) { $i++; if ($i -eq $n) { return $e } }
    }
  }
  return $null
}

function Capture($win, $path) {
  $h = [IntPtr]$win.hwnd
  if ([FcWin]::IsIconic($h)) { [void][FcWin]::ShowWindow($h, 9); Start-Sleep -Milliseconds 300 }
  $bmp = New-Object System.Drawing.Bitmap($win.width, $win.height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [FcWin]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  # Some windows (games, GPU surfaces) render black through PrintWindow: copy the screen instead.
  $c = $bmp.GetPixel([int]($win.width / 2), [int]($win.height / 2))
  if (-not $ok -or ($c.R -eq 0 -and $c.G -eq 0 -and $c.B -eq 0)) {
    [void][FcWin]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 250
    $g.CopyFromScreen($win.x, $win.y, 0, 0, $bmp.Size)
  }
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bmp.Dispose()
}

$result = [ordered]@{ ok = $true }
try {
  switch ($a.action) {
    'list' { $result.windows = @(Get-Windows | Where-Object { $_.process -notin @('explorer', 'TextInputHost', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost', 'ApplicationFrameHost', 'SystemSettings') }) }
    default {
      $win = Find-Window
      if (-not $win) { throw ('No window found for ' + ($a | ConvertTo-Json -Compress)) }
      $result.window = $win
      $el = $null
      if ($a.action -eq 'click' -or $a.action -eq 'type') {
        $el = Find-Element $win $a.target
        if (-not $el) { throw ('No control named or with id "' + $a.target + '" in the window') }
        $result.control = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '') + ' "' + $el.Current.Name + '"'
      }
      if ($a.action -eq 'click') {
        $done = $false
        foreach ($p in @([System.Windows.Automation.InvokePattern]::Pattern, [System.Windows.Automation.TogglePattern]::Pattern, [System.Windows.Automation.SelectionItemPattern]::Pattern, [System.Windows.Automation.ExpandCollapsePattern]::Pattern)) {
          $pat = $null
          try { $pat = $el.GetCurrentPattern($p) } catch { continue }
          if ($p -eq [System.Windows.Automation.InvokePattern]::Pattern) { $pat.Invoke() }
          elseif ($p -eq [System.Windows.Automation.TogglePattern]::Pattern) { $pat.Toggle() }
          elseif ($p -eq [System.Windows.Automation.SelectionItemPattern]::Pattern) { $pat.Select() }
          else { $pat.Expand() }
          $done = $true; break
        }
        $c = $el.Current
        if (-not $done -and $c.NativeWindowHandle -and (Get-Kind $c) -eq 'Button') {
          # BM_CLICK, posted so a click handler that opens a dialog can't block this script.
          [void][FcWin]::PostMessage([IntPtr]$c.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero); $done = $true
        }
        if (-not $done) {
          $r = $c.BoundingRectangle
          if ($r.IsEmpty) { throw ('The control cannot be clicked: it has no position on screen') }
          [void][FcWin]::SetForegroundWindow([IntPtr]$win.hwnd)
          Start-Sleep -Milliseconds 150
          [FcWin]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
        }
        Start-Sleep -Milliseconds 400
      }
      elseif ($a.action -eq 'type') {
        $vp = $null
        try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
        $c = $el.Current
        if ($vp -and -not $vp.Current.IsReadOnly) { $vp.SetValue([string]$a.text) }
        elseif ($c.NativeWindowHandle -and (Get-Kind $c) -eq 'Edit') { [FcWin]::SetText([IntPtr]$c.NativeWindowHandle, [string]$a.text) }
        else { $el.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait([string]$a.text) }
        Start-Sleep -Milliseconds 250
      }
      elseif ($a.action -eq 'keys') {
        [void][FcWin]::SetForegroundWindow([IntPtr]$win.hwnd)
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait([string]$a.keys)
        Start-Sleep -Milliseconds 350
      }
      elseif ($a.action -eq 'close') {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$win.hwnd)
        $wp = $root.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
        $wp.Close()
      }
      if ($a.action -ne 'close') {
        $win = Find-Window
        if ($win) {
          $result.window = $win
          $result.tree = @(Get-Tree $win)
          if ($a.out) { Capture $win $a.out; $result.image = $a.out }
        }
      }
    }
  }
} catch {
  $result = [ordered]@{ ok = $false; error = $_.Exception.Message }
}
$result | ConvertTo-Json -Depth 6 -Compress
`;
