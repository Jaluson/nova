param(
    [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$Package = Get-Content -Raw -Path "package.json" | ConvertFrom-Json
$Version = $Package.version
$ExePath = Join-Path $Root "src-tauri\target\release\nova.exe"
$OutputPath = Join-Path $Root $OutputDir
$StagePath = Join-Path $OutputPath "Nova-$Version-windows-portable"
$ZipPath = Join-Path $OutputPath "Nova-$Version-windows-portable.zip"

Write-Host "Building CSS..."
npm run build:css
if ($LASTEXITCODE -ne 0) {
    Write-Error "CSS build failed with exit code $LASTEXITCODE"
    exit 1
}

Write-Host "Building portable executable..."
npx tauri build --no-bundle
if ($LASTEXITCODE -ne 0) {
    Write-Error "Tauri build failed with exit code $LASTEXITCODE"
    exit 1
}

if (-not (Test-Path $ExePath)) {
    throw "Build output not found: $ExePath"
}

New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
if (Test-Path $StagePath) {
    Remove-Item -Recurse -Force -Path $StagePath
}
New-Item -ItemType Directory -Force -Path (Join-Path $StagePath "data\.jvm") | Out-Null
Copy-Item -Path $ExePath -Destination (Join-Path $StagePath "nova.exe") -Force
New-Item -ItemType File -Force -Path (Join-Path $StagePath "data\.jvm\.keep") | Out-Null

Write-Host "Creating portable zip..."
Compress-Archive -Path $StagePath -DestinationPath $ZipPath -Force

Write-Host "Portable package created:"
Write-Host $ZipPath
