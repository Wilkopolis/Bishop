# Builds a self-contained Bishop for win-x64 (no .NET install needed on the target PC)
# and zips it to release\Bishop-<version>-win-x64.zip.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$name = "Bishop-$version-win-x64"
$out = Join-Path $root "release\publish\$name"
$zip = Join-Path $root "release\$name.zip"

Write-Host "Building frontend..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

Write-Host "Publishing self-contained $name..."
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet publish desktop-host/Bishop.csproj -c Release -r win-x64 --self-contained true `
    -p:Version=$version -p:SatelliteResourceLanguages=en -o $out
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

Write-Host "Zipping to $zip..."
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $out -DestinationPath $zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Done: $zip ($size MB). Unzip anywhere and run $name\Bishop.exe."
