$ErrorActionPreference = "Stop"

$Root = "C:\jev-router"
$Lab = "$Root\model-lab"

$RouterConfig = "$Root\config\config.json"
$StateFile = "$Lab\seen-models.json"
$PendingFile = "$Lab\pending-models.json"
$LogFile = "$Lab\watch.log"

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

function Add-Candidate($List, $Provider, $Tier, $Model) {

    # Só avaliamos os tiers principais.
    if ($Tier -notin @("fast", "balanced", "frontier")) {
        return
    }

    if ([string]::IsNullOrWhiteSpace($Model)) {
        return
    }

    # Neste PC só queremos modelos oficiais dessas duas famílias.
    if ($Provider -eq "openai" -and $Model -notmatch "^gpt-") {
        return
    }

    if ($Provider -eq "anthropic" -and $Model -notmatch "^claude-") {
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

    @($newModels) |
        ConvertTo-Json -Depth 8 |
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