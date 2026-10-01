$ErrorActionPreference = "Continue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot

$RuntimeFile = Join-Path $ProjectRoot "runtime\runtime-paths.json"
$PendingFile = Join-Path $ProjectRoot "model-lab\pending-models.json"

# pending-models.json vem de fontes remotas: remove qualquer
# caractere fora do formato de nome de modelo antes de exibir
# (evita sequencias de escape no terminal).
function Format-SafeText($Value) {

    $text = [string]$Value

    if ($text.Length -gt 128) {
        $text = $text.Substring(0, 128)
    }

    return ($text -replace '[^A-Za-z0-9._:-]', '?')
}

Write-Host ""
Write-Host "======================================="
Write-Host " Jev Smart Router - Status"
Write-Host "======================================="
Write-Host ""

Write-Host "Containers:"
docker ps `
    --filter "name=jev-router" `
    --filter "name=jev-model-watcher" `
    --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

Write-Host ""
Write-Host "Router health:"

try {

    $response = Invoke-WebRequest `
        -Uri "http://127.0.0.1:4000/healthz" `
        -UseBasicParsing `
        -TimeoutSec 3

    Write-Host "  HTTP $($response.StatusCode) - OK"
}
catch {
    Write-Host "  INDISPONIVEL"
}

Write-Host ""
Write-Host "Wrappers:"

foreach ($name in @("codex", "claude")) {

    $cmd = Get-Command $name -ErrorAction SilentlyContinue

    if ($cmd) {
        Write-Host "  $name -> $($cmd.Source)"
    }
    else {
        Write-Host "  $name -> NAO ENCONTRADO"
    }
}

Write-Host ""
Write-Host "Runtime:"

if (Test-Path $RuntimeFile) {

    $runtime = Get-Content $RuntimeFile -Raw |
        ConvertFrom-Json

    Write-Host "  Codex real  -> $($runtime.codex)"
    Write-Host "  Claude real -> $($runtime.claude)"
}
else {
    Write-Host "  runtime-paths.json nao encontrado."
}

Write-Host ""
Write-Host "Model watcher:"

try {

    $lastWatcherLogs = docker logs `
        jev-model-watcher `
        --tail 4 `
        2>&1

    foreach ($line in $lastWatcherLogs) {
        Write-Host "  $line"
    }
}
catch {
    Write-Host "  log indisponivel."
}

Write-Host ""
Write-Host "Benchmarks pendentes:"

if (-not (Test-Path $PendingFile)) {
    Write-Host "  0"
}
else {

    try {

        $raw = Get-Content $PendingFile -Raw

        if ([string]::IsNullOrWhiteSpace($raw)) {
            Write-Host "  0"
        }
        else {

            $parsed = $raw | ConvertFrom-Json

            if ($null -eq $parsed) {
                Write-Host "  0"
            }
            else {
                $items = @($parsed) |
                    Where-Object { $null -ne $_ }

                Write-Host "  $($items.Count)"

                foreach ($item in $items) {
                    Write-Host (
                        "    {0} / {1} / {2}" -f `
                        (Format-SafeText $item.provider),
                        (Format-SafeText $item.tier),
                        (Format-SafeText $item.candidate)
                    )
                }
            }
        }
    }
    catch {
        Write-Host "  ERRO lendo pending-models.json"
    }
}

Write-Host ""
