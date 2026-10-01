$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $ProjectRoot "bin"
$ConfigDir = Join-Path $ProjectRoot "config"
$RuntimeDir = Join-Path $ProjectRoot "runtime"
$ModelLabDir = Join-Path $ProjectRoot "model-lab"

$RuntimeFile = Join-Path $RuntimeDir "runtime-paths.json"

$ConfigFile = Join-Path $ConfigDir "config.json"
$ConfigExample = Join-Path $ConfigDir "config.example.json"

$EnvFile = Join-Path $ConfigDir "env"
$EnvExample = Join-Path $ConfigDir "env.example"

$CodexWrapper = Join-Path $BinDir "codex.cmd"
$ClaudeWrapper = Join-Path $BinDir "claude.cmd"
$PreflightFile = Join-Path $BinDir "preflight.ps1"

$ClaudeDirectSettings = Join-Path $ModelLabDir "claude-direct-settings.json"

Write-Host ""
Write-Host "======================================="
Write-Host " Jev Smart Router - Instalacao"
Write-Host "======================================="
Write-Host ""

function Test-IsOurWrapperPath($Path) {

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
        $fullBin = [System.IO.Path]::GetFullPath($BinDir)

        return $fullPath.StartsWith(
            $fullBin,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    catch {
        return $false
    }
}

function Find-RealApplication($Name) {

    $commands = @(
        Get-Command $Name -All -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandType -eq "Application"
        }
    )

    $preferred = @(
        $commands |
        Where-Object {
            -not (Test-IsOurWrapperPath $_.Source)
        } |
        Sort-Object @{
            Expression = {
                $extension = [System.IO.Path]::GetExtension($_.Source)

                switch ($extension.ToLowerInvariant()) {
                    ".exe" { 0 }
                    ".cmd" { 1 }
                    ".bat" { 2 }
                    default { 3 }
                }
            }
        }
    )

    if ($preferred.Count -gt 0) {
        return $preferred[0].Source
    }

    return $null
}

function New-RandomHexToken([int]$Bytes = 32) {

    $buffer = New-Object byte[] $Bytes

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()

    try {
        $rng.GetBytes($buffer)
    }
    finally {
        $rng.Dispose()
    }

    return (
        $buffer |
        ForEach-Object { $_.ToString("x2") }
    ) -join ""
}

function Get-EnvValue($Path, $Key) {

    if (-not (Test-Path $Path)) {
        return $null
    }

    foreach ($line in Get-Content $Path) {

        if (
            $line -match "^\s*$([regex]::Escape($Key))=(.*)$"
        ) {
            return $Matches[1]
        }
    }

    return $null
}

function Set-EnvValue($Path, $Key, $Value) {

    $lines = @()

    if (Test-Path $Path) {
        $lines = @(Get-Content $Path)
    }

    $found = $false
    $newLines = @()

    foreach ($line in $lines) {

        if (
            $line -match "^\s*$([regex]::Escape($Key))="
        ) {
            $newLines += "$Key=$Value"
            $found = $true
        }
        else {
            $newLines += $line
        }
    }

    if (-not $found) {

        if (
            $newLines.Count -gt 0 -and
            -not [string]::IsNullOrWhiteSpace(
                $newLines[$newLines.Count - 1]
            )
        ) {
            $newLines += ""
        }

        $newLines += "$Key=$Value"
    }

    $newLines |
        Set-Content $Path -Encoding UTF8
}

function Read-SecureText($Prompt) {

    $secure = Read-Host $Prompt -AsSecureString

    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
        $secure
    )

    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            $ptr
        )
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

function Write-CliWrapper(
    [string]$CliName,
    [string]$RealPath,
    [string]$Destination
) {

    $extension = [System.IO.Path]::GetExtension(
        $RealPath
    ).ToLowerInvariant()

    if ($extension -in @(".cmd", ".bat")) {
        $launchLine = 'call "' + $RealPath + '" %*'
    }
    else {
        $launchLine = '"' + $RealPath + '" %*'
    }

    $content = @"
@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preflight.ps1" -Cli $CliName

$launchLine

set "JEV_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %JEV_EXIT_CODE%
"@

    Set-Content `
        -Path $Destination `
        -Value $content `
        -Encoding ASCII
}

function Invoke-DockerCommand([string[]]$DockerArgs) {

    $tempDockerConfig = Join-Path `
        $ProjectRoot `
        "docker-temp-config\config.json"

    if (Test-Path $tempDockerConfig) {

        $configDir = Split-Path -Parent $tempDockerConfig

        & docker --config $configDir @DockerArgs
    }
    else {
        & docker @DockerArgs
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Docker falhou: docker $($DockerArgs -join ' ')"
    }
}

# ------------------------------------------------------------
# Diretorios
# ------------------------------------------------------------

foreach ($dir in @(
    $BinDir,
    $ConfigDir,
    $RuntimeDir,
    $ModelLabDir,
    (Join-Path $ModelLabDir "reports")
)) {
    New-Item -ItemType Directory -Force $dir |
        Out-Null
}

# ------------------------------------------------------------
# Requisitos
# ------------------------------------------------------------

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker nao encontrado no PATH."
}

try {
    docker version | Out-Null
}
catch {
    throw "Docker foi encontrado, mas nao esta disponivel."
}

if (-not (Test-Path $PreflightFile)) {
    throw "Arquivo ausente: $PreflightFile"
}

# ------------------------------------------------------------
# Configuracao local do router
# ------------------------------------------------------------

if (-not (Test-Path $ConfigFile)) {

    if (-not (Test-Path $ConfigExample)) {
        throw "Arquivo ausente: $ConfigExample"
    }

    Copy-Item $ConfigExample $ConfigFile

    Write-Host "Criado:"
    Write-Host "  $ConfigFile"
    Write-Host ""
}
else {
    Write-Host "config.json existente preservado."
}

if (-not (Test-Path $EnvFile)) {

    if (Test-Path $EnvExample) {
        Copy-Item $EnvExample $EnvFile
    }
    else {
        New-Item -ItemType File -Force $EnvFile |
            Out-Null
    }

    Write-Host "Criado:"
    Write-Host "  $EnvFile"
    Write-Host ""
}
else {
    Write-Host "config/env existente preservado."
}

# ------------------------------------------------------------
# JEV_ROUTER_TOKEN
# ------------------------------------------------------------

$routerToken = Get-EnvValue $EnvFile "JEV_ROUTER_TOKEN"

if ([string]::IsNullOrWhiteSpace($routerToken)) {

    $routerToken = New-RandomHexToken 32

    Set-EnvValue `
        $EnvFile `
        "JEV_ROUTER_TOKEN" `
        $routerToken

    Write-Host "JEV_ROUTER_TOKEN gerado automaticamente."
}
else {
    Write-Host "JEV_ROUTER_TOKEN existente preservado."
}

# ------------------------------------------------------------
# TYPESAFE_API_KEY
# ------------------------------------------------------------

$typesafeKey = Get-EnvValue $EnvFile "TYPESAFE_API_KEY"

if ([string]::IsNullOrWhiteSpace($typesafeKey)) {

    Write-Host ""
    Write-Host "TYPESAFE_API_KEY nao configurada."

    $typesafeKey = Read-SecureText `
        "Digite sua TYPESAFE_API_KEY"

    if ([string]::IsNullOrWhiteSpace($typesafeKey)) {
        throw "TYPESAFE_API_KEY nao pode ficar vazia."
    }

    Set-EnvValue `
        $EnvFile `
        "TYPESAFE_API_KEY" `
        $typesafeKey

    Write-Host "TYPESAFE_API_KEY salva em config/env."
}

Write-Host ""

# ------------------------------------------------------------
# Settings diretos para benchmark Claude
# ------------------------------------------------------------

if (-not (Test-Path $ClaudeDirectSettings)) {

    @'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_CUSTOM_HEADERS": ""
  }
}
'@ |
        Set-Content `
            $ClaudeDirectSettings `
            -Encoding UTF8

    Write-Host "Criado:"
    Write-Host "  $ClaudeDirectSettings"
    Write-Host ""
}

# ------------------------------------------------------------
# Descobrir CLIs reais
# ------------------------------------------------------------

$codexPath = Find-RealApplication "codex"
$claudePath = Find-RealApplication "claude"

if (-not $codexPath) {
    throw @"
Codex real nao encontrado.

Instale e autentique o Codex antes de continuar.
"@
}

if (-not $claudePath) {
    throw @"
Claude Code real nao encontrado.

Instale e autentique o Claude Code antes de continuar.
"@
}

Write-Host "Codex real:"
Write-Host "  $codexPath"
Write-Host ""

Write-Host "Claude real:"
Write-Host "  $claudePath"
Write-Host ""

# ------------------------------------------------------------
# Runtime local
# ------------------------------------------------------------

$runtime = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    projectRoot = $ProjectRoot
    codex = $codexPath
    claude = $claudePath
}

$runtime |
    ConvertTo-Json -Depth 5 |
    Set-Content $RuntimeFile -Encoding UTF8

Write-Host "Runtime salvo em:"
Write-Host "  $RuntimeFile"
Write-Host ""

# ------------------------------------------------------------
# Wrappers
# ------------------------------------------------------------

Write-CliWrapper `
    -CliName "codex" `
    -RealPath $codexPath `
    -Destination $CodexWrapper

Write-CliWrapper `
    -CliName "claude" `
    -RealPath $claudePath `
    -Destination $ClaudeWrapper

Write-Host "Wrappers gerados:"
Write-Host "  $CodexWrapper"
Write-Host "  $ClaudeWrapper"
Write-Host ""

$oldLauncher = Join-Path $BinDir "launcher.ps1"

if (Test-Path $oldLauncher) {
    Remove-Item $oldLauncher -Force
}

# ------------------------------------------------------------
# PATH
# ------------------------------------------------------------

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

$cleanParts = @(
    $parts |
    Where-Object {
        $_.TrimEnd("\") -ine $BinDir.TrimEnd("\")
    }
)

$newUserPath = @(
    $BinDir
    $cleanParts
) -join ";"

[Environment]::SetEnvironmentVariable(
    "Path",
    $newUserPath,
    "User"
)

# Atualizar tambem o processo atual.
$currentProcessParts = @(
    $env:Path -split ";" |
    Where-Object {
        $_.TrimEnd("\") -ine $BinDir.TrimEnd("\")
    }
)

$env:Path = @(
    $BinDir
    $currentProcessParts
) -join ";"

Write-Host "PATH configurado."
Write-Host ""

# ------------------------------------------------------------
# Docker
# ------------------------------------------------------------

Write-Host "Construindo e iniciando containers..."
Write-Host ""

Invoke-DockerCommand @(
    "compose",
    "-f",
    (Join-Path $ProjectRoot "compose.yaml"),
    "up",
    "-d",
    "--build"
)

Write-Host ""
Write-Host "Containers iniciados."
Write-Host ""

# ------------------------------------------------------------
# Health check
# ------------------------------------------------------------

$healthy = $false

for ($i = 0; $i -lt 30; $i++) {

    try {

        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:4000/healthz" `
            -UseBasicParsing `
            -TimeoutSec 2

        if ($response.StatusCode -eq 200) {
            $healthy = $true
            break
        }
    }
    catch {}

    Start-Sleep -Seconds 1
}

if ($healthy) {
    Write-Host "Jev Router: HEALTHY"
}
else {
    Write-Warning "O container iniciou, mas /healthz nao respondeu 200."
}

# ------------------------------------------------------------
# Estado dos logins
# ------------------------------------------------------------

Write-Host ""
Write-Host "Verificando CLIs..."
Write-Host ""

try {
    & $codexPath --version
}
catch {
    Write-Warning "Falha ao consultar a versao do Codex."
}

try {
    & $claudePath --version
}
catch {
    Write-Warning "Falha ao consultar a versao do Claude."
}

Write-Host ""

try {
    & $codexPath login status
}
catch {
    Write-Warning "Nao foi possivel verificar o login do Codex."
}

# ------------------------------------------------------------
# Resultado
# ------------------------------------------------------------

Write-Host ""
Write-Host "======================================="
Write-Host " Instalacao concluida"
Write-Host "======================================="
Write-Host ""

Write-Host "Router:"
Write-Host "  http://127.0.0.1:4000"
Write-Host ""

Write-Host "Live View:"
Write-Host "  http://127.0.0.1:4100"
Write-Host ""

Write-Host "Model watcher:"
Write-Host "  executa ao subir e novamente a cada 24 horas"
Write-Host ""

Write-Host "IMPORTANTE:"
Write-Host "Configure Claude Code e Codex para usarem o router."
Write-Host "Veja a secao 'Configuracao dos clientes' no README.md."
Write-Host ""

Write-Host "Para verificar o sistema:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\status.ps1"
Write-Host ""