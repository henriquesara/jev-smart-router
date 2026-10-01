$ErrorActionPreference = "Stop"

# Caminhos relativos a este script (model-lab\ dentro do projeto).
$Lab = $PSScriptRoot
$Root = Split-Path -Parent $Lab

$RouterConfig = Join-Path $Root "config\config.json"
$StateFile = Join-Path $Lab "seen-models.json"
$PendingFile = Join-Path $Lab "pending-models.json"
$LogFile = Join-Path $Lab "watch.log"

# Mantenha esta regra igual a docker-watcher.mjs e benchmark.ps1.
$ModelNameMaxLength = 128
$ModelNamePattern = '^[A-Za-z0-9][A-Za-z0-9._:-]*\z'

$ProviderModelPrefixes = @{
    "openai" = "gpt-"
    "anthropic" = "claude-"
}

$Sources = @(
    "https://raw.githubusercontent.com/dirien/jev-router/main/config/anthropic-only.json",
    "https://raw.githubusercontent.com/dirien/jev-router/main/config/anthropic-fable.json",
    "https://raw.githubusercontent.com/dirien/jev-router/main/config/default.json"
)

function Log($Text) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Text"
    Add-Content $LogFile $line
    Write-Host $line
}

function Test-ModelName($Provider, $Model) {

    if (
        $Provider -isnot [string] -or
        -not $ProviderModelPrefixes.ContainsKey($Provider) -or
        $Provider -cne $Provider.ToLowerInvariant()
    ) {
        return $false
    }

    if ($Model -isnot [string]) {
        return $false
    }

    if ($Model.Length -lt 1 -or $Model.Length -gt $ModelNameMaxLength) {
        return $false
    }

    if ($Model -cnotmatch $ModelNamePattern) {
        return $false
    }

    # Neste PC só queremos modelos oficiais dessas duas famílias.
    return $Model.StartsWith(
        $ProviderModelPrefixes[$Provider],
        [System.StringComparison]::Ordinal
    )
}

function Add-Candidate($List, $Provider, $Tier, $Model) {

    # Só avaliamos os tiers principais.
    if ($Tier -isnot [string] -or $Tier -cnotin @("fast", "balanced", "frontier")) {
        return
    }

    if ($null -eq $Model) {
        return
    }

    if (-not (Test-ModelName $Provider $Model)) {
        # Não ecoa o valor recebido: ele não é confiável.
        Log "Modelo remoto rejeitado (provider=$Provider, tier=$Tier): nome fora do formato permitido."
        return
    }

    $key = "$Provider|$Model"

    if (-not $List.ContainsKey($key)) {
        $List[$key] = [ordered]@{
            provider = $Provider
            tier = $Tier
            model = $Model
        }
    }
}

# Garante que a pasta existe.
New-Item -ItemType Directory -Force $Lab | Out-Null

# Carrega a configuração atual do router.
$current = Get-Content $RouterConfig -Raw | ConvertFrom-Json

$discovered = @{}

foreach ($url in $Sources) {

    try {
        $remote = Invoke-RestMethod -Uri $url -TimeoutSec 20

        if ($remote.surfaces.anthropic) {

            foreach ($p in $remote.surfaces.anthropic.PSObject.Properties) {
                Add-Candidate $discovered "anthropic" $p.Name $p.Value.model
            }
        }

        if ($remote.surfaces.openai) {

            foreach ($p in $remote.surfaces.openai.PSObject.Properties) {
                Add-Candidate $discovered "openai" $p.Name $p.Value.model
            }
        }
    }
    catch {
        Log "Falha consultando $url : $($_.Exception.Message)"
    }
}

# ------------------------------------------------------------
# Primeiro uso
# ------------------------------------------------------------
# Cria baseline com tudo que já existe atualmente.
# Esses modelos NÃO serão considerados "novos".
# ------------------------------------------------------------

if (-not (Test-Path $StateFile)) {

    $baseline = [ordered]@{
        initializedAt = (Get-Date).ToString("o")
        seen = @($discovered.Keys | Sort-Object)
    }

    $baseline |
        ConvertTo-Json -Depth 8 |
        Set-Content $StateFile -Encoding UTF8

    # Importante:
    # @() | ConvertTo-Json não envia objeto ao Set-Content.
    # Por isso gravamos literalmente um array JSON vazio.
    "[]" | Set-Content $PendingFile -Encoding UTF8

    Log "Baseline criado com $($discovered.Count) modelos conhecidos."
    Log "Nenhum benchmark executado no primeiro uso."

    exit 0
}

# ------------------------------------------------------------
# Carregar estado existente
# ------------------------------------------------------------

$state = Get-Content $StateFile -Raw | ConvertFrom-Json

$seen = @{}

foreach ($key in $state.seen) {
    $seen[$key] = $true
}

$newModels = @()

# ------------------------------------------------------------
# Detectar modelos que ainda não vimos
# ------------------------------------------------------------

foreach ($key in $discovered.Keys) {

    if (-not $seen.ContainsKey($key)) {

        $item = $discovered[$key]

        $currentModel = $null

        try {
            $surface = $current.surfaces.($item.provider)
            $tierObject = $surface.($item.tier)

            if ($tierObject) {
                $currentModel = $tierObject.model
            }
        }
        catch {
            $currentModel = $null
        }

        if ($null -ne $currentModel -and -not (Test-ModelName $item.provider $currentModel)) {
            Log "Modelo atual em config.json rejeitado ($($item.provider)/$($item.tier)): nome fora do formato permitido."
            $currentModel = $null
        }

        $newModels += [ordered]@{
            detectedAt = (Get-Date).ToString("o")
            provider = $item.provider
            tier = $item.tier
            candidate = $item.model
            current = $currentModel
            status = "pending-benchmark"
        }

        Log "NOVO MODELO: $($item.provider) / $($item.model) / tier sugerido=$($item.tier)"
    }
}

# ------------------------------------------------------------
# Se houver novidades, enviar para benchmark
# ------------------------------------------------------------

if ($newModels.Count -gt 0) {

    # Preserva pendencias ainda nao avaliadas (mesmo comportamento
    # do docker-watcher.mjs) em vez de sobrescreve-las.
    $existingPending = @()

    if (Test-Path $PendingFile) {
        try {
            $parsedPending = Get-Content $PendingFile -Raw | ConvertFrom-Json

            if ($null -ne $parsedPending) {
                $existingPending = @($parsedPending) | Where-Object { $null -ne $_ }
            }
        }
        catch {
            Log "AVISO: pending-models.json invalido; sera substituido."
        }
    }

    $merged = [ordered]@{}

    foreach ($entry in @($existingPending) + @($newModels)) {
        $merged["$($entry.provider)|$($entry.tier)|$($entry.candidate)"] = $entry
    }

    ConvertTo-Json -InputObject @($merged.Values) -Depth 8 |
        Set-Content $PendingFile -Encoding UTF8

    foreach ($key in $discovered.Keys) {
        $seen[$key] = $true
    }

    $updated = [ordered]@{
        updatedAt = (Get-Date).ToString("o")
        seen = @($seen.Keys | Sort-Object)
    }

    $updated |
        ConvertTo-Json -Depth 8 |
        Set-Content $StateFile -Encoding UTF8

    Log "$($newModels.Count) novo(s) modelo(s) aguardando benchmark."
}
else {

    # Mantém pending-models.json válido mesmo sem novidades.
    if (-not (Test-Path $PendingFile)) {
        "[]" | Set-Content $PendingFile -Encoding UTF8
    }

    Log "Nenhum modelo novo detectado."
}