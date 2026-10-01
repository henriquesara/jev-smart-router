param(
    [switch]$KeepContainers,
    [switch]$RemoveRuntime
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $ProjectRoot "bin"
$RuntimeDir = Join-Path $ProjectRoot "runtime"

Write-Host ""
Write-Host "======================================="
Write-Host " Jev Smart Router - Desinstalacao"
Write-Host "======================================="
Write-Host ""

$currentUserPath = [Environment]::GetEnvironmentVariable(
    "Path",
    "User"
)

$parts = @(
    $currentUserPath -split ";" |
    Where-Object {
        -not [string]::IsNullOrWhiteSpace($_)
    }
)

$newParts = @(
    $parts |
    Where-Object {
        $_.TrimEnd("\") -ine $BinDir.TrimEnd("\")
    }
)

[Environment]::SetEnvironmentVariable(
    "Path",
    ($newParts -join ";"),
    "User"
)

Write-Host "Removido do PATH:"
Write-Host "  $BinDir"
Write-Host ""

if (-not $KeepContainers) {

    Write-Host "Parando containers..."

    $tempDockerConfig = Join-Path `
        $ProjectRoot `
        "docker-temp-config\config.json"

    if (Test-Path $tempDockerConfig) {

        $configDir = Split-Path -Parent $tempDockerConfig

        & docker --config $configDir `
            compose `
            -f (Join-Path $ProjectRoot "compose.yaml") `
            down
    }
    else {

        & docker `
            compose `
            -f (Join-Path $ProjectRoot "compose.yaml") `
            down
    }

    Write-Host ""
}

if ($RemoveRuntime -and (Test-Path $RuntimeDir)) {

    Get-ChildItem $RuntimeDir -Force |
        Where-Object {
            $_.Name -ne ".gitkeep"
        } |
        Remove-Item -Force -Recurse

    Write-Host "Runtime local removido."
    Write-Host ""
}

Write-Host "config/env e config/config.json foram preservados."
Write-Host "Nenhum segredo foi apagado automaticamente."
Write-Host ""

Write-Host "Desinstalacao concluida."
Write-Host "Abra um novo terminal para atualizar o PATH."
Write-Host ""