# Helper for the FreeCode installer and uninstaller.
#   helper.ps1 stop          stop FreeCode processes started from this installation
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
    $node = Join-Path $dir 'runtime\node.exe'
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
