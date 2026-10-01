param(
    [ValidateSet("codex", "claude")]
    [string]$Cli = "codex"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PendingFile = Join-Path $ProjectRoot "model-lab\pending-models.json"
$BenchmarkFile = Join-Path $ProjectRoot "model-lab\benchmark.ps1"

if (-not (Test-Path $PendingFile)) {
    exit 0
}

try {
    $raw = Get-Content $PendingFile -Raw

    if ([string]::IsNullOrWhiteSpace($raw)) {
        exit 0
    }

    $parsed = $raw | ConvertFrom-Json

    if ($null -eq $parsed) {
        exit 0
    }

    $pending = @($parsed) |
        Where-Object { $null -ne $_ }

    if ($pending.Count -eq 0) {
        exit 0
    }

    Write-Host ""
    Write-Host "[Jev] Novo modelo detectado."
    Write-Host "[Jev] Executando mini-benchmark antes de iniciar $Cli..."
    Write-Host ""

    & powershell.exe `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File $BenchmarkFile

    if ($LASTEXITCODE -ne 0) {
        Write-Warning "[Jev] Benchmark retornou codigo $LASTEXITCODE."
        Write-Warning "[Jev] O CLI sera iniciado normalmente."
    }

    Write-Host ""

    exit 0
}
catch {
    Write-Warning "[Jev] Falha no preflight: $($_.Exception.Message)"
    Write-Warning "[Jev] O CLI sera iniciado normalmente."

    exit 0
}