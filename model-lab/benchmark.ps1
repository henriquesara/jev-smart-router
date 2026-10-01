$ErrorActionPreference = "Stop"

# Caminhos relativos a este script (model-lab\ dentro do projeto).
$Lab = $PSScriptRoot
$Root = Split-Path -Parent $Lab

$CasesFile = Join-Path $Lab "cases.json"
$PendingFile = Join-Path $Lab "pending-models.json"
$CacheFile = Join-Path $Lab "benchmark-cache.json"
$ReportsDir = Join-Path $Lab "reports"
$ClaudeSettings = Join-Path $Lab "claude-direct-settings.json"
$LogFile = Join-Path $Lab "benchmark.log"

$RuntimeFile = Join-Path $Root "runtime\runtime-paths.json"

if (-not (Test-Path $RuntimeFile)) {
    throw "Runtime nao encontrado: $RuntimeFile. Execute scripts\install.ps1 primeiro."
}

$runtime = Get-Content $RuntimeFile -Raw |
    ConvertFrom-Json

$RealCodex = $runtime.codex
$RealClaude = $runtime.claude

if (
    [string]::IsNullOrWhiteSpace($RealCodex) -or
    -not (Test-Path $RealCodex)
) {
    throw "Codex real nao encontrado no runtime: $RealCodex"
}

if (
    [string]::IsNullOrWhiteSpace($RealClaude) -or
    -not (Test-Path $RealClaude)
) {
    throw "Claude real nao encontrado no runtime: $RealClaude"
}

# Primeira etapa deliberadamente pequena para economizar cota.
$MaxCasesPerTier = 3

New-Item -ItemType Directory -Force $ReportsDir | Out-Null

function Log($Text) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Text"
    Add-Content $LogFile $line
    Write-Host $line
}

# ------------------------------------------------------------
# Validacao de nomes de modelos
# ------------------------------------------------------------
# pending-models.json e escrito pelo watcher a partir de fontes
# remotas. Nao confiamos nele: o nome vira argumento de linha de
# comando do Codex/Claude. Mantenha igual a docker-watcher.mjs.
# ------------------------------------------------------------

$ModelNameMaxLength = 128
$ModelNamePattern = '^[A-Za-z0-9][A-Za-z0-9._:-]*\z'

$ProviderModelPrefixes = @{
    "openai" = "gpt-"
    "anthropic" = "claude-"
}

function Test-Provider($Provider) {

    return (
        $Provider -is [string] -and
        $ProviderModelPrefixes.ContainsKey($Provider) -and
        $Provider -ceq $Provider.ToLowerInvariant()
    )
}

function Test-ModelName($Provider, $Model) {

    if (-not (Test-Provider $Provider)) {
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

    return $Model.StartsWith(
        $ProviderModelPrefixes[$Provider],
        [System.StringComparison]::Ordinal
    )
}

# O Codex instalado via npm e um .cmd, e o PowerShell 5.1 repassa
# os argumentos ao cmd.exe, que reinterpreta metacaracteres.
# Bloqueamos qualquer argumento dinamico que o cmd possa interpretar.
function Assert-SafeCliArgument($Executable, $Value) {

    if ($Executable -notmatch '\.(cmd|bat)\z') {
        return
    }

    $text = [string]$Value

    if ($text -match '["%!\x00-\x1F\x7F]') {
        throw "Argumento recusado: contem caracteres inseguros para cmd.exe."
    }

    # Sem espacos o PowerShell nao coloca aspas, entao & | < > ^ ( )
    # seriam interpretados pelo cmd.exe.
    if ($text -notmatch '\s' -and $text -match '[&|<>^()]') {
        throw "Argumento recusado: contem caracteres inseguros para cmd.exe."
    }
}

function Normalize-Answer($Text) {

    if ($null -eq $Text) {
        return ""
    }

    return (($Text.ToString().Trim()) -replace '\s+', ' ')
}

function Run-OpenAIModel($Model, $Prompt) {

    $messageFile = Join-Path $env:TEMP (
        "jev-bench-message-" + [guid]::NewGuid().ToString() + ".txt"
    )

    $errorFile = Join-Path $env:TEMP (
        "jev-bench-error-" + [guid]::NewGuid().ToString() + ".txt"
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    try {

        Assert-SafeCliArgument $RealCodex $Model
        Assert-SafeCliArgument $RealCodex $messageFile
        Assert-SafeCliArgument $RealCodex $Prompt

        $cliArgs = @(
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "-c", 'model_provider="openai"',
            "-c", 'model_reasoning_effort="low"',
            "-m", $Model,
            "-o", $messageFile,
            $Prompt
        )

        & $RealCodex @cliArgs 2>$errorFile | Out-Null

        $exitCode = $LASTEXITCODE

        $sw.Stop()

        $answer = ""

        if (Test-Path $messageFile) {
            $answer = Get-Content $messageFile -Raw
        }

        $errorText = ""

        if (Test-Path $errorFile) {
            $errorText = Get-Content $errorFile -Raw
        }

        return [ordered]@{
            success = ($exitCode -eq 0)
            exitCode = $exitCode
            answer = (Normalize-Answer $answer)
            milliseconds = $sw.ElapsedMilliseconds
            error = (Normalize-Answer $errorText)
        }
    }
    catch {

        $sw.Stop()

        return [ordered]@{
            success = $false
            exitCode = -1
            answer = ""
            milliseconds = $sw.ElapsedMilliseconds
            error = $_.Exception.Message
        }
    }
    finally {

        Remove-Item $messageFile -Force -ErrorAction SilentlyContinue
        Remove-Item $errorFile -Force -ErrorAction SilentlyContinue
    }
}

function Run-AnthropicModel($Model, $Prompt) {

    $errorFile = Join-Path $env:TEMP (
        "jev-bench-claude-error-" + [guid]::NewGuid().ToString() + ".txt"
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    try {

        Assert-SafeCliArgument $RealClaude $Model
        Assert-SafeCliArgument $RealClaude $ClaudeSettings
        Assert-SafeCliArgument $RealClaude $Prompt

        $cliArgs = @(
            "-p",
            "--model", $Model,
            "--settings", $ClaudeSettings,
            "--output-format", "json",
            "--no-session-persistence",
            $Prompt
        )

        $raw = & $RealClaude @cliArgs 2>$errorFile

        $exitCode = $LASTEXITCODE

        $sw.Stop()

        $answer = ""
        $errorText = ""

        if (Test-Path $errorFile) {
            $errorText = Get-Content $errorFile -Raw
        }

        if ($exitCode -eq 0 -and $raw) {

            try {
                $obj = ($raw -join "`n") | ConvertFrom-Json

                if ($obj.result) {
                    $answer = $obj.result
                }
            }
            catch {
                $answer = ($raw -join "`n")
            }
        }

        return [ordered]@{
            success = ($exitCode -eq 0)
            exitCode = $exitCode
            answer = (Normalize-Answer $answer)
            milliseconds = $sw.ElapsedMilliseconds
            error = (Normalize-Answer $errorText)
        }
    }
    catch {

        $sw.Stop()

        return [ordered]@{
            success = $false
            exitCode = -1
            answer = ""
            milliseconds = $sw.ElapsedMilliseconds
            error = $_.Exception.Message
        }
    }
    finally {

        Remove-Item $errorFile -Force -ErrorAction SilentlyContinue
    }
}

function Run-Model($Provider, $Model, $Prompt) {

    # Segunda barreira: nunca chama uma CLI com nome nao validado.
    if (-not (Test-ModelName $Provider $Model)) {
        throw "Modelo recusado: nome fora do formato permitido."
    }

    if ($Provider -eq "openai") {
        return Run-OpenAIModel $Model $Prompt
    }

    if ($Provider -eq "anthropic") {
        return Run-AnthropicModel $Model $Prompt
    }

    throw "Provider nao suportado."
}

function Cache-Key($Provider, $Tier, $Model, $CaseId) {
    return "$Provider|$Tier|$Model|$CaseId"
}

# ------------------------------------------------------------
# Carregar casos
# ------------------------------------------------------------

if (-not (Test-Path $CasesFile)) {
    throw "Arquivo de casos não encontrado: $CasesFile"
}

$cases = Get-Content $CasesFile -Raw | ConvertFrom-Json

# ------------------------------------------------------------
# Carregar pendencias
# ------------------------------------------------------------

if (-not (Test-Path $PendingFile)) {
    Log "Nenhum pending-models.json encontrado."
    exit 0
}

$pendingRaw = Get-Content $PendingFile -Raw

if ([string]::IsNullOrWhiteSpace($pendingRaw)) {
    Log "Nenhum modelo pendente. Zero chamadas realizadas."
    exit 0
}

try {
    $parsedPending = $pendingRaw | ConvertFrom-Json
}
catch {
    Log "ERRO: pending-models.json contem JSON invalido."
    throw
}

# No Windows PowerShell 5, ConvertFrom-Json aplicado a []
# pode resultar em $null. Tratamos explicitamente esse caso.
if ($null -eq $parsedPending) {
    Log "Nenhum modelo pendente. Zero chamadas realizadas."
    exit 0
}

$pending = @($parsedPending) | Where-Object { $null -ne $_ }

if ($pending.Count -eq 0) {
    Log "Nenhum modelo pendente. Zero chamadas realizadas."
    exit 0
}

# ------------------------------------------------------------
# Carregar cache
# ------------------------------------------------------------

$cache = @{}

if (Test-Path $CacheFile) {

    $cacheRaw = Get-Content $CacheFile -Raw

    if (-not [string]::IsNullOrWhiteSpace($cacheRaw)) {

        try {
            $parsedCache = $cacheRaw | ConvertFrom-Json

            if ($null -ne $parsedCache) {

                $cachedItems = @($parsedCache) |
                    Where-Object {
                        $null -ne $_ -and
                        -not [string]::IsNullOrWhiteSpace($_.key)
                    }

                foreach ($item in $cachedItems) {
                    $cache[$item.key] = $item
                }
            }
        }
        catch {
            Log "AVISO: benchmark-cache.json invalido. Cache ignorado nesta execucao."
        }
    }
}

function Save-Cache {

    $items = @($cache.Values)

    if ($items.Count -eq 0) {
        "[]" | Set-Content $CacheFile -Encoding UTF8
        return
    }

    $items |
        ConvertTo-Json -Depth 12 |
        Set-Content $CacheFile -Encoding UTF8
}

function Get-Or-RunResult(
    $Provider,
    $Tier,
    $Model,
    $Case
) {

    $key = Cache-Key $Provider $Tier $Model $Case.id

    if ($cache.ContainsKey($key)) {

        Log "CACHE: $Provider / $Model / $($Case.id)"

        return $cache[$key]
    }

    Log "TESTE: $Provider / $Model / $Tier / $($Case.id)"

    $run = Run-Model $Provider $Model $Case.prompt

    $passed = $false

    if ($run.success) {

        try {
            $passed = [regex]::IsMatch(
                $run.answer,
                $Case.expected,
                [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
            )
        }
        catch {
            $passed = $false
        }
    }

    $entry = [ordered]@{
        key = $key
        checkedAt = (Get-Date).ToString("o")
        provider = $Provider
        tier = $Tier
        model = $Model
        caseId = $Case.id
        success = $run.success
        passed = $passed
        milliseconds = $run.milliseconds
        answer = $run.answer
        error = $run.error
    }

    $cache[$key] = [pscustomobject]$entry

    Save-Cache

    return [pscustomobject]$entry
}

# ------------------------------------------------------------
# Benchmark
# ------------------------------------------------------------

$remaining = @()

foreach ($candidateInfo in $pending) {

    if ($null -eq $candidateInfo) {
        continue
    }

    $provider = $candidateInfo.provider
    $tier = $candidateInfo.tier
    $candidate = $candidateInfo.candidate
    $current = $candidateInfo.current

    # Protecao extra contra registros incompletos.
    if (
        [string]::IsNullOrWhiteSpace($provider) -or
        [string]::IsNullOrWhiteSpace($tier) -or
        [string]::IsNullOrWhiteSpace($candidate)
    ) {
        Log "Ignorado registro pendente incompleto."
        continue
    }

    # Valores nao confiaveis: nunca sao ecoados no log quando invalidos.
    if (-not (Test-Provider $provider)) {

        Log "Ignorado registro pendente com provider nao suportado."
        continue
    }

    if ($tier -isnot [string] -or $tier -cnotin @("fast", "balanced", "frontier")) {

        Log "Ignorado registro pendente com tier nao benchmarkavel ($provider)."
        continue
    }

    if (-not (Test-ModelName $provider $candidate)) {

        Log "Ignorado candidato rejeitado ($provider/$tier): nome fora do formato permitido."
        continue
    }

    if ([string]::IsNullOrWhiteSpace($current)) {

        Log "Sem modelo atual para comparar: $provider/$tier"
        $remaining += $candidateInfo
        continue
    }

    if (-not (Test-ModelName $provider $current)) {

        Log "Ignorado: modelo atual ($provider/$tier) fora do formato permitido."
        $remaining += $candidateInfo
        continue
    }

    if ($candidate -ceq $current) {

        Log "Candidato ja e o modelo atual: $candidate"
        continue
    }

    $tierCases = @($cases.$tier) |
        Where-Object { $null -ne $_ } |
        Select-Object -First $MaxCasesPerTier

    if ($tierCases.Count -eq 0) {

        Log "Nenhum caso para tier $tier"
        $remaining += $candidateInfo
        continue
    }

    Log "------------------------------------------------"
    Log "Benchmark: $provider / $tier"
    Log "Atual:     $current"
    Log "Candidato: $candidate"
    Log "Casos:     $($tierCases.Count)"

    $currentResults = @()
    $candidateResults = @()

    foreach ($case in $tierCases) {

        $currentResults += Get-Or-RunResult `
            $provider `
            $tier `
            $current `
            $case

        $candidateResults += Get-Or-RunResult `
            $provider `
            $tier `
            $candidate `
            $case
    }

    $currentPassed = @(
        $currentResults |
        Where-Object { $_.passed }
    ).Count

    $candidatePassed = @(
        $candidateResults |
        Where-Object { $_.passed }
    ).Count

    $currentSuccess = @(
        $currentResults |
        Where-Object { $_.success }
    ).Count

    $candidateSuccess = @(
        $candidateResults |
        Where-Object { $_.success }
    ).Count

    $currentAverageMs = [math]::Round(
        (
            $currentResults |
            Measure-Object milliseconds -Average
        ).Average,
        0
    )

    $candidateAverageMs = [math]::Round(
        (
            $candidateResults |
            Measure-Object milliseconds -Average
        ).Average,
        0
    )

    $recommendation = "INCONCLUSIVO"

    # Falha de disponibilidade/execucao elimina o candidato
    # nesta primeira etapa.
    if ($candidateSuccess -lt $tierCases.Count) {

        $recommendation = "MANTER-ATUAL-CANDIDATO-FALHOU"
    }
    elseif ($candidatePassed -lt $currentPassed) {

        $recommendation = "MANTER-ATUAL"
    }
    elseif ($candidatePassed -gt $currentPassed) {

        # Nao promove automaticamente.
        # Apenas libera para uma bateria maior.
        $recommendation = "CANDIDATO-ETAPA-2"
    }
    elseif (
        $candidatePassed -eq $tierCases.Count -and
        $currentPassed -eq $tierCases.Count -and
        $candidateAverageMs -lt ($currentAverageMs * 0.85)
    ) {

        $recommendation = "CANDIDATO-ETAPA-2"
    }
    elseif (
        $candidatePassed -eq $tierCases.Count -and
        $currentPassed -eq $tierCases.Count
    ) {

        $recommendation = "EMPATE-ETAPA-1"
    }

    $report = [ordered]@{
        generatedAt = (Get-Date).ToString("o")

        provider = $provider
        tier = $tier

        current = [ordered]@{
            model = $current
            passed = $currentPassed
            total = $tierCases.Count
            averageMilliseconds = $currentAverageMs
        }

        candidate = [ordered]@{
            model = $candidate
            passed = $candidatePassed
            total = $tierCases.Count
            averageMilliseconds = $candidateAverageMs
        }

        recommendation = $recommendation

        note = "Etapa 1 e um filtro barato. Nenhuma alteracao automatica foi feita no router."

        results = [ordered]@{
            current = $currentResults
            candidate = $candidateResults
        }
    }

    $safeCandidate = $candidate -replace '[^A-Za-z0-9._-]', '_'

    $reportFile = Join-Path $ReportsDir (
        "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$provider-$tier-$safeCandidate.json"
    )

    $report |
        ConvertTo-Json -Depth 20 |
        Set-Content $reportFile -Encoding UTF8

    Log "RESULTADO:"
    Log "Atual:     $currentPassed/$($tierCases.Count), media ${currentAverageMs}ms"
    Log "Candidato: $candidatePassed/$($tierCases.Count), media ${candidateAverageMs}ms"
    Log "Decisao:   $recommendation"
    Log "Relatorio: $reportFile"
}

# ------------------------------------------------------------
# Regravar pendencias
# ------------------------------------------------------------
# Somente permanecem pendencias que nao puderam ser avaliadas.
# Importante: pipeline com @() vazio nao cria arquivo corretamente
# no Windows PowerShell 5, entao gravamos [] explicitamente.
# ------------------------------------------------------------

if ($remaining.Count -eq 0) {

    "[]" | Set-Content $PendingFile -Encoding UTF8
}
else {

    @($remaining) |
        ConvertTo-Json -Depth 10 |
        Set-Content $PendingFile -Encoding UTF8
}

Log "Benchmark finalizado."