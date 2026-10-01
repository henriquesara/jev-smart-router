param(
    # Mostra o plano (combinacoes modelo + effort, argumentos e cache)
    # sem chamar nenhum modelo e sem alterar cache, pendencias ou relatorios.
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Caminhos relativos a este script (model-lab\ dentro do projeto).
$Lab = $PSScriptRoot
$Root = Split-Path -Parent $Lab

$CasesFile = Join-Path $Lab "cases.json"
$EffortsFile = Join-Path $Lab "efforts.json"
$ClientEffortsFile = Join-Path $Lab "client-efforts.json"
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

# Limite de efforts testados por tier (evita explosao combinatoria).
$MaxEffortsPerTier = 3

$BenchmarkTiers = @("fast", "balanced", "frontier")

if (-not $DryRun) {
    New-Item -ItemType Directory -Force $ReportsDir | Out-Null
}

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

# ------------------------------------------------------------
# Reasoning effort por provider
# ------------------------------------------------------------
# Allowlists fixas. efforts.json so escolhe valores dentro delas;
# nada vindo de JSON vira argumento sem passar por Test-Effort.
#
# OpenAI/Codex: config model_reasoning_effort (via -c).
# Anthropic/Claude Code: flag --effort.
# As semanticas sao independentes. A ordem de cada lista so e usada
# para desempate dentro do mesmo provider (menor effort primeiro).
# ------------------------------------------------------------

$EffortAllowlist = @{
    "openai" = @("low", "medium", "high", "xhigh")
    "anthropic" = @("low", "medium", "high", "xhigh", "max")
}

# Prefixos em modelsWithoutEffort (ex.: claude-haiku-).
$ModelPrefixPattern = '^[a-z0-9][a-z0-9.-]*\z'

function Test-Effort($Provider, $Effort) {

    if (-not (Test-Provider $Provider)) {
        return $false
    }

    if ($Effort -isnot [string]) {
        return $false
    }

    return ($EffortAllowlist[$Provider] -ccontains $Effort)
}

function Get-EffortRank($Provider, $Effort) {

    if ($null -eq $Effort) {
        return -1
    }

    return [array]::IndexOf(
        [string[]]$EffortAllowlist[$Provider],
        [string]$Effort
    )
}

# Valor usado na chave de cache: "none" quando nenhum effort e enviado.
function Format-Effort($Effort) {

    if ($null -eq $Effort) {
        return "none"
    }

    return $Effort
}

# Terminologia usada no benchmark e nos relatorios:
#   modelo atual  modelo que o router usa hoje no tier (pending-models.json)
#   baseline      effort com que o modelo atual e medido nesta comparacao
#   cliente       effort que o Codex/Claude usa no dia a dia, somente quando
#                 declarado em client-efforts.json (local, fora do Git)
#   recomendado   effort da melhor combinacao do candidato (nunca aplicado)
#
# Comportamento anterior a efforts.json: baseline OpenAI low,
# Claude sem --effort (default do CLI).
function New-LegacyEffortProfiles {

    $profiles = @{}

    foreach ($provider in @("openai", "anthropic")) {

        $baseline = @{}
        $matrix = @{}

        foreach ($tier in $BenchmarkTiers) {

            if ($provider -eq "openai") {
                $baseline[$tier] = "low"
            }
            else {
                $baseline[$tier] = $null
            }

            $matrix[$tier] = @()
        }

        $profiles[$provider] = @{
            supportsEffort = $true
            modelsWithoutEffort = @()
            baseline = $baseline
            baselineFromClient = $false
            matrix = $matrix
        }
    }

    return $profiles
}

function ConvertTo-EffortProfiles($Raw) {

    $profiles = New-LegacyEffortProfiles

    if ($null -eq $Raw -or $Raw.version -ne 1) {
        throw "efforts.json invalido: version deve ser 1."
    }

    foreach ($provider in @("openai", "anthropic")) {

        $source = $Raw.providers.$provider

        if ($null -eq $source) {
            continue
        }

        $effortProfile = $profiles[$provider]

        if ($source.supportsEffort -isnot [bool]) {
            throw "efforts.json invalido: supportsEffort de $provider deve ser true/false."
        }

        if (-not $source.supportsEffort) {

            # Provider sem effort: nunca enviamos flag alguma.
            $effortProfile.supportsEffort = $false

            foreach ($tier in $BenchmarkTiers) {
                $effortProfile.baseline[$tier] = $null
                $effortProfile.matrix[$tier] = @()
            }

            continue
        }

        $prefixes = @()

        foreach ($prefix in @($source.modelsWithoutEffort)) {

            if ($null -eq $prefix) {
                continue
            }

            if (
                $prefix -is [string] -and
                $prefix.Length -le 64 -and
                $prefix -cmatch $ModelPrefixPattern -and
                $prefix.StartsWith($ProviderModelPrefixes[$provider], [System.StringComparison]::Ordinal)
            ) {
                $prefixes += $prefix
            }
            else {
                Log "AVISO: efforts.json ($provider): prefixo em modelsWithoutEffort descartado."
            }
        }

        $effortProfile.modelsWithoutEffort = $prefixes

        $fromClient = $source.PSObject.Properties["baselineFromClient"]

        if ($null -ne $fromClient) {

            if ($fromClient.Value -isnot [bool]) {
                throw "efforts.json invalido: baselineFromClient de $provider deve ser true/false."
            }

            $effortProfile.baselineFromClient = $fromClient.Value
        }

        # "baseline" e o nome atual; "current" (primeira versao deste
        # arquivo) e aceito por compatibilidade com o mesmo significado.
        $baselineSource = $source.baseline

        if ($null -eq $source.PSObject.Properties["baseline"]) {
            $baselineSource = $source.current
        }

        foreach ($tier in $BenchmarkTiers) {

            # Tier omitido mantem o padrao legado; null explicito = sem effort.
            $hasBaseline = (
                $null -ne $baselineSource -and
                $null -ne $baselineSource.PSObject.Properties[$tier]
            )

            $baselineEffort = $baselineSource.$tier

            if (-not $hasBaseline) {
                # Sem alteracao: fica o valor de New-LegacyEffortProfiles.
                $baselineEffort = $effortProfile.baseline[$tier]
            }

            if ($null -eq $baselineEffort) {
                $effortProfile.baseline[$tier] = $null
            }
            elseif (Test-Effort $provider $baselineEffort) {
                $effortProfile.baseline[$tier] = $baselineEffort
            }
            else {
                # Valor fora da allowlist nunca e ecoado.
                Log "AVISO: efforts.json ($provider/$tier): effort baseline invalido; usando o padrao legado."
            }

            $valid = @()
            $dropped = 0

            foreach ($effort in @($source.matrix.$tier)) {

                if ($null -eq $effort) {
                    continue
                }

                if (-not (Test-Effort $provider $effort)) {
                    $dropped++
                    continue
                }

                if ($valid -ccontains $effort) {
                    continue
                }

                if ($valid.Count -ge $MaxEffortsPerTier) {
                    $dropped++
                    continue
                }

                $valid += $effort
            }

            if ($dropped -gt 0) {
                Log "AVISO: efforts.json ($provider/$tier): $dropped effort(s) descartado(s) (fora da allowlist ou acima do limite de $MaxEffortsPerTier)."
            }

            $effortProfile.matrix[$tier] = $valid
        }
    }

    return $profiles
}

# client-efforts.json e opcional e local (ignorado pelo Git): declara o
# effort que o cliente usa no dia a dia. O benchmark nunca le as
# configuracoes globais do Codex/Claude (podem conter tokens) e nunca
# as altera. Ausente ou invalido => "unknown".
function ConvertTo-ClientEfforts($Raw) {

    $clients = @{
        "openai" = $null
        "anthropic" = $null
    }

    if ($null -eq $Raw -or $Raw.version -ne 1) {
        Log "AVISO: client-efforts.json ignorado: version deve ser 1."
        return $clients
    }

    foreach ($provider in @("openai", "anthropic")) {

        $effort = $Raw.providers.$provider.effort

        if ($null -eq $effort) {
            continue
        }

        if (Test-Effort $provider $effort) {
            $clients[$provider] = $effort
        }
        else {
            # Valor fora da allowlist nunca e ecoado.
            Log "AVISO: client-efforts.json ($provider): effort invalido; tratado como desconhecido."
        }
    }

    return $clients
}

# Effort do cliente para relatorios: valor + origem.
function Get-ClientEffortInfo($Provider) {

    $effortProfile = $EffortProfiles[$Provider]

    if ($null -ne $effortProfile -and -not $effortProfile.supportsEffort) {
        return [ordered]@{ effort = "not-applicable"; source = $EffortProfilesSource }
    }

    $effort = $ClientEfforts[$Provider]

    if ($null -eq $effort) {
        return [ordered]@{ effort = "unknown"; source = "unknown" }
    }

    return [ordered]@{ effort = $effort; source = "client-efforts.json" }
}

# Effort baseline pedido (antes de considerar suporte do modelo) e origem.
# Com baselineFromClient=true e effort do cliente conhecido, o modelo
# atual e medido com o effort real do cliente; caso contrario usa o
# valor fixo do perfil (efforts.json ou padrao legado).
function Get-BaselineRequest($Provider, $Tier) {

    $effortProfile = $EffortProfiles[$Provider]
    $clientEffort = $ClientEfforts[$Provider]

    if (
        $effortProfile.supportsEffort -and
        $effortProfile.baselineFromClient -and
        $null -ne $clientEffort
    ) {
        return @{ effort = $clientEffort; source = "client-efforts.json" }
    }

    return @{ effort = $effortProfile.baseline[$Tier]; source = $EffortProfilesSource }
}

# Effort efetivamente enviado para um modelo: $null quando o provider
# ou o modelo nao suportam effort (nenhuma flag e passada).
function Resolve-Effort($Provider, $Model, $Effort) {

    $effortProfile = $EffortProfiles[$Provider]

    if ($null -eq $effortProfile -or -not $effortProfile.supportsEffort) {
        return $null
    }

    foreach ($prefix in $effortProfile.modelsWithoutEffort) {

        if ($Model.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
            return $null
        }
    }

    if ($null -eq $Effort) {
        return $null
    }

    if (-not (Test-Effort $Provider $Effort)) {
        throw "Effort recusado: fora da allowlist de $Provider."
    }

    return $Effort
}

# Rotulo para relatorios:
#   <effort>        effort enviado explicitamente
#   not-applicable  provider/modelo sem suporte a effort
#   cli-default     suportado, mas nenhum effort enviado (o CLI decide)
function Get-EffortLabel($Provider, $Model, $Effort) {

    if ($null -ne $Effort) {
        return $Effort
    }

    $effortProfile = $EffortProfiles[$Provider]

    if ($null -eq $effortProfile -or -not $effortProfile.supportsEffort) {
        return "not-applicable"
    }

    foreach ($prefix in $effortProfile.modelsWithoutEffort) {

        if ($Model.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
            return "not-applicable"
        }
    }

    return "cli-default"
}

# Effort baseline do modelo atual e lista de efforts do candidato.
# Matriz vazia mantem o comportamento antigo: candidato roda
# com o mesmo effort do baseline.
function Get-EffortPlan($Provider, $Tier, $Current, $Candidate) {

    $effortProfile = $EffortProfiles[$Provider]
    $baselineRequest = Get-BaselineRequest $Provider $Tier

    $requested = @($effortProfile.matrix[$Tier])

    if ($requested.Count -eq 0) {
        $requested = @($baselineRequest.effort)
    }

    $candidateEfforts = New-Object System.Collections.ArrayList
    $seen = @{}

    foreach ($effort in $requested) {

        $resolved = Resolve-Effort $Provider $Candidate $effort
        $token = Format-Effort $resolved

        if ($seen.ContainsKey($token)) {
            continue
        }

        $seen[$token] = $true
        [void]$candidateEfforts.Add($resolved)
    }

    return @{
        baseline = (Resolve-Effort $Provider $Current $baselineRequest.effort)
        baselineSource = $baselineRequest.source
        candidate = $candidateEfforts
    }
}

function Normalize-Answer($Text) {

    if ($null -eq $Text) {
        return ""
    }

    return (($Text.ToString().Trim()) -replace '\s+', ' ')
}

function Get-OpenAICliArgs($Model, $Effort, $MessageFile, $Prompt) {

    $cliArgs = @(
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-c", 'model_provider="openai"'
    )

    if ($null -ne $Effort) {

        if (-not (Test-Effort "openai" $Effort)) {
            throw "Effort recusado: fora da allowlist de openai."
        }

        # Valor da allowlist fixa; nunca texto livre.
        $cliArgs += @("-c", ('model_reasoning_effort="' + $Effort + '"'))
    }

    $cliArgs += @(
        "-m", $Model,
        "-o", $MessageFile,
        $Prompt
    )

    return $cliArgs
}

function Get-AnthropicCliArgs($Model, $Effort, $Prompt) {

    $cliArgs = @(
        "-p",
        "--model", $Model
    )

    if ($null -ne $Effort) {

        if (-not (Test-Effort "anthropic" $Effort)) {
            throw "Effort recusado: fora da allowlist de anthropic."
        }

        $cliArgs += @("--effort", $Effort)
    }

    $cliArgs += @(
        "--settings", $ClaudeSettings,
        "--output-format", "json",
        "--no-session-persistence",
        $Prompt
    )

    return $cliArgs
}

function Run-OpenAIModel($Model, $Effort, $Prompt) {

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

        if ($null -ne $Effort) {
            Assert-SafeCliArgument $RealCodex $Effort
        }

        $cliArgs = Get-OpenAICliArgs $Model $Effort $messageFile $Prompt

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

        # codex exec -o grava apenas a resposta final; uso de tokens
        # nao fica disponivel de forma confiavel aqui.
        return [ordered]@{
            success = ($exitCode -eq 0)
            exitCode = $exitCode
            answer = (Normalize-Answer $answer)
            milliseconds = $sw.ElapsedMilliseconds
            outputTokens = $null
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
            outputTokens = $null
            error = $_.Exception.Message
        }
    }
    finally {

        Remove-Item $messageFile -Force -ErrorAction SilentlyContinue
        Remove-Item $errorFile -Force -ErrorAction SilentlyContinue
    }
}

function Run-AnthropicModel($Model, $Effort, $Prompt) {

    $errorFile = Join-Path $env:TEMP (
        "jev-bench-claude-error-" + [guid]::NewGuid().ToString() + ".txt"
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    try {

        Assert-SafeCliArgument $RealClaude $Model
        Assert-SafeCliArgument $RealClaude $ClaudeSettings
        Assert-SafeCliArgument $RealClaude $Prompt

        if ($null -ne $Effort) {
            Assert-SafeCliArgument $RealClaude $Effort
        }

        $cliArgs = Get-AnthropicCliArgs $Model $Effort $Prompt

        $raw = & $RealClaude @cliArgs 2>$errorFile

        $exitCode = $LASTEXITCODE

        $sw.Stop()

        $answer = ""
        $errorText = ""
        $outputTokens = $null

        if (Test-Path $errorFile) {
            $errorText = Get-Content $errorFile -Raw
        }

        if ($exitCode -eq 0 -and $raw) {

            try {
                $obj = ($raw -join "`n") | ConvertFrom-Json

                if ($obj.result) {
                    $answer = $obj.result
                }

                # Contagem informada pelo proprio Claude Code; ausente => null.
                $tokens = $obj.usage.output_tokens

                if ($tokens -is [int] -or $tokens -is [long]) {
                    $outputTokens = $tokens
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
            outputTokens = $outputTokens
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
            outputTokens = $null
            error = $_.Exception.Message
        }
    }
    finally {

        Remove-Item $errorFile -Force -ErrorAction SilentlyContinue
    }
}

function Run-Model($Provider, $Model, $Effort, $Prompt) {

    # Segunda barreira: nunca chama uma CLI com nome nao validado.
    if (-not (Test-ModelName $Provider $Model)) {
        throw "Modelo recusado: nome fora do formato permitido."
    }

    if ($null -ne $Effort -and -not (Test-Effort $Provider $Effort)) {
        throw "Effort recusado: fora da allowlist de $Provider."
    }

    if ($Provider -eq "openai") {
        return Run-OpenAIModel $Model $Effort $Prompt
    }

    if ($Provider -eq "anthropic") {
        return Run-AnthropicModel $Model $Effort $Prompt
    }

    throw "Provider nao suportado."
}

function Cache-Key($Provider, $Tier, $Model, $Effort, $CaseId) {
    return "$Provider|$Tier|$Model|$(Format-Effort $Effort)|$CaseId"
}

# ------------------------------------------------------------
# Resumo e recomendacao (funcoes puras, testaveis sem chamadas)
# ------------------------------------------------------------

function Get-ComboSummary($Provider, $Model, $Effort, $EffortLabel, $Results, $Total) {

    $results = @($Results | Where-Object { $null -ne $_ })

    $passed = @($results | Where-Object { $_.passed }).Count
    $successes = @($results | Where-Object { $_.success }).Count

    $averageMs = 0

    if ($results.Count -gt 0) {
        $averageMs = [math]::Round(
            ($results | Measure-Object milliseconds -Average).Average,
            0
        )
    }

    return [ordered]@{
        model = $Model
        effort = $EffortLabel
        effortRank = (Get-EffortRank $Provider $Effort)
        passed = $passed
        total = $Total
        failures = ($Total - $successes)
        averageMilliseconds = $averageMs
    }
}

# Mesmas regras da etapa 1 anterior, aplicadas a cada combinacao.
# $Baseline = resumo do modelo atual medido com o effort baseline.
function Get-ComboStatus($Baseline, $Combo) {

    $total = $Combo.total

    # Falha de disponibilidade/execucao elimina a combinacao
    # nesta primeira etapa.
    if ($Combo.failures -gt 0) {
        return "MANTER-ATUAL-CANDIDATO-FALHOU"
    }

    if ($Combo.passed -lt $Baseline.passed) {
        return "MANTER-ATUAL"
    }

    if ($Combo.passed -gt $Baseline.passed) {

        # Nao promove automaticamente.
        # Apenas libera para uma bateria maior.
        return "CANDIDATO-ETAPA-2"
    }

    if (
        $Combo.passed -eq $total -and
        $Baseline.passed -eq $total -and
        $Combo.averageMilliseconds -lt ($Baseline.averageMilliseconds * 0.85)
    ) {
        return "CANDIDATO-ETAPA-2"
    }

    if ($Combo.passed -eq $total -and $Baseline.passed -eq $total) {
        return "EMPATE-ETAPA-1"
    }

    return "INCONCLUSIVO"
}

# Melhor combinacao do candidato: mais acertos, menos falhas de
# execucao, menor effort e, por fim, menor latencia.
function Select-BestCombo($Combos) {

    $sorted = @($Combos) |
        Sort-Object `
            @{ Expression = { $_.passed }; Descending = $true },
            @{ Expression = { $_.failures }; Ascending = $true },
            @{ Expression = { $_.effortRank }; Ascending = $true },
            @{ Expression = { $_.averageMilliseconds }; Ascending = $true }

    return (@($sorted) | Select-Object -First 1)
}

# ------------------------------------------------------------
# Carregar casos
# ------------------------------------------------------------

if (-not (Test-Path $CasesFile)) {
    throw "Arquivo de casos nao encontrado: $CasesFile"
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
# Carregar perfis de effort
# ------------------------------------------------------------

if (Test-Path $EffortsFile) {

    try {
        $effortsRaw = Get-Content $EffortsFile -Raw | ConvertFrom-Json
    }
    catch {
        Log "ERRO: efforts.json contem JSON invalido."
        throw
    }

    $EffortProfilesSource = "efforts.json"
    $EffortProfiles = ConvertTo-EffortProfiles $effortsRaw
}
else {

    Log "efforts.json ausente: usando comportamento legado (baseline OpenAI low, Claude sem --effort)."
    $EffortProfilesSource = "legacy-default"
    $EffortProfiles = New-LegacyEffortProfiles
}

# Effort do cliente: somente o que foi declarado localmente.
$ClientEfforts = @{ "openai" = $null; "anthropic" = $null }

if (Test-Path $ClientEffortsFile) {

    try {
        $clientRaw = Get-Content $ClientEffortsFile -Raw | ConvertFrom-Json
    }
    catch {
        $clientRaw = $null
        Log "AVISO: client-efforts.json contem JSON invalido; effort do cliente tratado como desconhecido."
    }

    if ($null -ne $clientRaw) {
        $ClientEfforts = ConvertTo-ClientEfforts $clientRaw
    }
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

                $migrated = 0

                foreach ($item in $cachedItems) {

                    $parts = ([string]$item.key).Split("|")

                    # Formato antigo provider|tier|model|caseId. O benchmark
                    # antigo sempre usava low no Codex e nenhum --effort no
                    # Claude, entao a migracao preserva o significado.
                    if (
                        $parts.Count -eq 4 -and
                        $null -eq $item.PSObject.Properties["effort"] -and
                        (Test-ModelName $parts[0] $parts[2])
                    ) {

                        $legacyEffort = $null

                        if ($parts[0] -ceq "openai") {
                            $legacyEffort = "low"
                        }

                        $newKey = Cache-Key $parts[0] $parts[1] $parts[2] $legacyEffort $parts[3]

                        $item.key = $newKey
                        $item | Add-Member -NotePropertyName effort -NotePropertyValue (
                            Get-EffortLabel $parts[0] $parts[2] $legacyEffort
                        ) -Force

                        $cache[$newKey] = $item
                        $migrated++
                        continue
                    }

                    $cache[$item.key] = $item
                }

                if ($migrated -gt 0) {
                    Log "Cache: $migrated entrada(s) no formato antigo convertida(s) para chave com effort."
                }
            }
        }
        catch {
            Log "AVISO: benchmark-cache.json invalido. Cache ignorado nesta execucao."
        }
    }
}

function Save-Cache {

    if ($DryRun) {
        return
    }

    $items = @($cache.Values)

    if ($items.Count -eq 0) {
        "[]" | Set-Content $CacheFile -Encoding UTF8
        return
    }

    $items |
        ConvertTo-Json -Depth 12 |
        Set-Content $CacheFile -Encoding UTF8
}

$script:PlannedCalls = 0

function Get-Or-RunResult(
    $Provider,
    $Tier,
    $Model,
    $Effort,
    $Case
) {

    $key = Cache-Key $Provider $Tier $Model $Effort $Case.id
    $effortLabel = Get-EffortLabel $Provider $Model $Effort

    if ($cache.ContainsKey($key)) {

        Log "CACHE: $Provider / $Model / effort=$effortLabel / $($Case.id)"

        return $cache[$key]
    }

    if ($DryRun) {

        $script:PlannedCalls++

        if ($Provider -eq "openai") {
            $planned = Get-OpenAICliArgs $Model $Effort "<arquivo-temporario>" "<prompt:$($Case.id)>"
        }
        else {
            $planned = Get-AnthropicCliArgs $Model $Effort "<prompt:$($Case.id)>"
        }

        Log "DRY-RUN: chamaria $Provider / $Model / effort=$effortLabel / $Tier / $($Case.id)"
        Log "DRY-RUN: args: $($planned -join ' ')"

        return $null
    }

    Log "TESTE: $Provider / $Model / effort=$effortLabel / $Tier / $($Case.id)"

    $run = Run-Model $Provider $Model $Effort $Case.prompt

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
        effort = $effortLabel
        caseId = $Case.id
        success = $run.success
        passed = $passed
        milliseconds = $run.milliseconds
        outputTokens = $run.outputTokens
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

if ($DryRun) {
    Log "DRY-RUN: nenhuma chamada sera feita; cache, pendencias e relatorios nao serao alterados."
}

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

    if ($tier -isnot [string] -or $tier -cnotin $BenchmarkTiers) {

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

    $plan = Get-EffortPlan $provider $tier $current $candidate

    $baselineEffort = $plan.baseline
    $baselineLabel = Get-EffortLabel $provider $current $baselineEffort
    $clientInfo = Get-ClientEffortInfo $provider

    $candidateLabels = @(
        foreach ($effort in $plan.candidate) {
            Get-EffortLabel $provider $candidate $effort
        }
    )

    Log "------------------------------------------------"
    Log "Benchmark: $provider / $tier"
    Log "Modelo atual do router: $current"
    Log "Effort baseline:        $baselineLabel (origem: $($plan.baselineSource))"
    Log "Effort do cliente:      $($clientInfo.effort) (origem: $($clientInfo.source))"
    Log "Candidato:              $candidate (efforts=$($candidateLabels -join ', '))"
    Log "Casos:                  $($tierCases.Count)"

    $baselineResults = @()

    foreach ($case in $tierCases) {

        $baselineResults += Get-Or-RunResult `
            $provider `
            $tier `
            $current `
            $baselineEffort `
            $case
    }

    $comboRuns = @()

    foreach ($effort in $plan.candidate) {

        $results = @()

        foreach ($case in $tierCases) {

            $results += Get-Or-RunResult `
                $provider `
                $tier `
                $candidate `
                $effort `
                $case
        }

        $comboRuns += ,@{
            effort = $effort
            results = $results
        }
    }

    if ($DryRun) {

        # Sem resultados reais nao ha recomendacao; a pendencia segue
        # intacta no arquivo.
        continue
    }

    $baselineSummary = Get-ComboSummary `
        $provider $current $baselineEffort $baselineLabel $baselineResults $tierCases.Count

    $combos = @()

    foreach ($run in $comboRuns) {

        $summary = Get-ComboSummary `
            $provider `
            $candidate `
            $run.effort `
            (Get-EffortLabel $provider $candidate $run.effort) `
            $run.results `
            $tierCases.Count

        $summary.versusBaseline = Get-ComboStatus $baselineSummary $summary
        $summary.promotedToStage2 = $false

        $combos += $summary
    }

    $best = Select-BestCombo $combos
    $recommendation = $best.versusBaseline

    # So a melhor combinacao, e apenas quando promissora, segue para a etapa 2.
    $stage2Candidates = @()

    if ($recommendation -eq "CANDIDATO-ETAPA-2") {

        $best.promotedToStage2 = $true

        $stage2Candidates += [ordered]@{
            provider = $provider
            tier = $tier
            model = $candidate
            effort = $best.effort
        }
    }

    $allCandidateResults = @(
        foreach ($run in $comboRuns) {
            $run.results
        }
    )

    $baselineMatchesClient = $null

    if ($clientInfo.source -eq "client-efforts.json") {
        $baselineMatchesClient = ($clientInfo.effort -ceq $baselineLabel)
    }

    $report = [ordered]@{
        generatedAt = (Get-Date).ToString("o")
        stage = 1

        provider = $provider
        tier = $tier

        # Modelo que o router usa hoje neste tier. O router so troca
        # modelo; ele nao define nem reescreve effort.
        routerTierModel = $current

        efforts = [ordered]@{

            # Effort com que o modelo atual foi medido nesta comparacao.
            baseline = [ordered]@{
                effort = $baselineLabel
                source = $plan.baselineSource
            }

            # Effort do cliente no dia a dia ("unknown" se nao declarado).
            client = $clientInfo

            # true/false somente quando o effort do cliente e conhecido.
            baselineMatchesClient = $baselineMatchesClient

            # Melhor combinacao do candidato. Sugestao: nada foi aplicado.
            recommended = [ordered]@{
                model = $candidate
                effort = $best.effort
                applied = $false
            }
        }

        # Modelo atual medido com o effort baseline.
        baseline = $baselineSummary

        # Melhor combinacao do candidato.
        candidate = $best

        candidates = $combos

        recommendation = $recommendation

        stage2 = [ordered]@{
            implemented = $false
            candidates = $stage2Candidates
        }

        note = "Etapa 1 e um filtro barato. Nenhuma alteracao foi feita no router nem nas configuracoes do Codex/Claude. O effort recomendado e apenas uma sugestao e nao foi aplicado."

        results = [ordered]@{
            baseline = $baselineResults
            candidate = $allCandidateResults
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
    Log "Baseline:    $current effort=$baselineLabel $($baselineSummary.passed)/$($tierCases.Count), media $($baselineSummary.averageMilliseconds)ms"

    foreach ($combo in $combos) {
        Log "Candidato:   $candidate effort=$($combo.effort) $($combo.passed)/$($tierCases.Count), falhas $($combo.failures), media $($combo.averageMilliseconds)ms -> $($combo.versusBaseline)"
    }

    Log "Recomendado: $candidate effort=$($best.effort) (sugestao; nao aplicado)"
    Log "Decisao:     $recommendation"
    Log "Relatorio:   $reportFile"
}

if ($DryRun) {

    Log "DRY-RUN: $($script:PlannedCalls) chamada(s) de modelo seriam feitas. Nada foi alterado."
    exit 0
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
