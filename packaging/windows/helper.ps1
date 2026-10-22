# Helper for the FreeCode installer and uninstaller.
#   helper.ps1 stop          close FreeCode (its window and engine) if it runs from this installation
#   helper.ps1 add-path      add the installation folder to the user's PATH
#   helper.ps1 remove-path   remove it again
# The installation folder comes from $env:FREECODE_INSTDIR.
param([Parameter(Mandatory = $true)][string]$Action)
$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:FREECODE_INSTDIR
if (-not $dir) { exit 1 }
$dir = $dir.TrimEnd('\')

function Get-PathValue($key) { $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') }
function Get-PathKind($key) {
  try { $key.GetValueKind('Path') } catch { [Microsoft.Win32.RegistryValueKind]::ExpandString }
}

switch ($Action) {
  'stop' {
    # The window first: its engine notices and saves before exiting.
    $app = Join-Path $dir 'FreeCode.exe'
    Get-CimInstance Win32_Process -Filter "Name = 'FreeCode.exe'" |
      Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $app) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    $node = Join-Path $dir 'runtime\node.exe'
    for ($i = 0; $i -lt 20; $i++) {
      $left = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $node) })
      if ($left.Count -eq 0) { break }
      Start-Sleep -Milliseconds 250
    }
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $node) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  }
  'add-path' {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    $current = Get-PathValue $key
    $parts = @($current -split ';' | Where-Object { $_ })
    if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir })) {
      $kind = if ($current) { Get-PathKind $key } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('Path', (($parts + $dir) -join ';'), $kind)
    }
    $key.Close()
  }
  'remove-path' {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($key) {
      $current = Get-PathValue $key
      if ($current) {
        $kind = Get-PathKind $key
        $parts = @($current -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $dir) })
        $key.SetValue('Path', ($parts -join ';'), $kind)
      }
      $key.Close()
    }
  }
}
exit 0
