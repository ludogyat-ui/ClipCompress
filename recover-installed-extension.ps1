param([Parameter(Mandatory=$true)][string]$ExtensionId)
$chromeRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
if (!(Test-Path $chromeRoot)) { Write-Error "Chrome User Data not found: $chromeRoot"; exit 1 }
$profiles = Get-ChildItem $chromeRoot -Directory | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }
$matches = @()
foreach ($profile in $profiles) {
  $extRoot = Join-Path $profile.FullName ('Extensions\' + $ExtensionId)
  if (Test-Path $extRoot) {
    Get-ChildItem $extRoot -Directory | ForEach-Object {
      $matches += [PSCustomObject]@{ Profile=$profile.Name; Version=$_.Name; Path=$_.FullName; Modified=$_.LastWriteTime }
    }
  }
}
if ($matches.Count -eq 0) {
  Write-Host "No store-installed copy found for $ExtensionId. If it was loaded unpacked, use the original source folder."
  exit 0
}
$best = $matches | Sort-Object Modified -Descending | Select-Object -First 1
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path ([Environment]::GetFolderPath('Desktop')) ("Recovered-Chrome-Extension-$ExtensionId-$stamp")
Copy-Item -Path $best.Path -Destination $dest -Recurse -Force
Write-Host "Recovered without modifying the installed copy."
Write-Host "Profile: $($best.Profile)"
Write-Host "Version: $($best.Version)"
Write-Host "Copied to: $dest"
