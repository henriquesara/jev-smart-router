# Testes do suporte a reasoning effort do model-lab.
#
# Nao faz nenhuma chamada real de modelo:
#   - unidades: funcoes de model-lab\benchmark.ps1 extraidas via AST;
#   - integracao: copia temporaria do model-lab executada com CLIs falsos
#     (.cmd) que apenas registram os argumentos recebidos.
#
# Uso (na raiz do projeto):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\model-lab-effort.tests.ps1
#
# Sai com codigo 1 se algum teste falhar. Arquivos temporarios ficam em
# %TEMP%\jev-effort-test-<guid> e sao removidos ao final.

$ErrorActionPreference = "Stop"

$Src = Join-Path (Split-Path -Parent $PSScriptRoot) "model-lab"

$script:fail = 0
$script:count = 0

function Check($Name, $Cond) {
    $script:count++
    if (-not $Cond) {
        $script:fail++
        Write-Host "FALHOU: $Name"
    }
}

function Throws($Block) {
    try { & $Block; return $false } catch { return $true }
}

# ============================================================
# Unidades
# ============================================================

$parseTokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $Src "benchmark.ps1"), [ref]$parseTokens, [ref]$parseErrors
)
Check "benchmark.ps1 sem erros de parse" ($parseErrors.Count -eq 0)

# Constantes de topo e funcoes; Log e funcoes com efeito colateral ficam de fora.
$defs = ""
$topAssignments = $ast.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $n.Parent.Parent -eq $ast
}, $false)
foreach ($a in $topAssignments) {
    if ($a.Extent.Text -match '^\$(ModelName|ProviderModelPrefixes|EffortAllowlist|ModelPrefixPattern|MaxEffortsPerTier|BenchmarkTiers)') {
        $defs += $a.Extent.Text + "`n"
    }
}
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($f.Name -notin @("Log", "Get-Or-RunResult", "Save-Cache")) {
        $defs += $f.Extent.Text + "`n"
    }
}

$script:logged = @()
function Log($Text) { $script:logged += $Text }
$ClaudeSettings = "claude-direct-settings.json"
$EffortProfilesSource = "efforts.json"
$ClientEfforts = @{ "openai" = $null; "anthropic" = $null }
. ([scriptblock]::Create($defs))

$effortsJson = Get-Content (Join-Path $Src "efforts.json") -Raw

# --- Allowlists ---------------------------------------------

Check "openai low" (Test-Effort "openai" "low")
Check "openai xhigh" (Test-Effort "openai" "xhigh")
Check "openai max recusado (so anthropic)" (-not (Test-Effort "openai" "max"))
Check "openai minimal recusado" (-not (Test-Effort "openai" "minimal"))
Check "anthropic max" (Test-Effort "anthropic" "max")
Check "anthropic minimal recusado" (-not (Test-Effort "anthropic" "minimal"))
Check "case sensitive" (-not (Test-Effort "openai" "LOW"))
Check "espaco recusado" (-not (Test-Effort "openai" "low "))
Check "provider invalido" (-not (Test-Effort "google" "low"))
Check "provider maiusculo" (-not (Test-Effort "OpenAI" "low"))

# --- Valores maliciosos --------------------------------------

Check "injecao -c" (-not (Test-Effort "openai" 'low" -c sandbox_mode="danger-full-access'))
Check "injecao &" (-not (Test-Effort "anthropic" "low & calc"))
Check "injecao |" (-not (Test-Effort "openai" "low|calc"))
Check "injecao %" (-not (Test-Effort "openai" "%COMSPEC%"))
Check "injecao quebra de linha" (-not (Test-Effort "openai" "low`r`ncalc"))
Check "null" (-not (Test-Effort "openai" $null))
Check "numero" (-not (Test-Effort "openai" 1))
Check "array" (-not (Test-Effort "openai" @("low")))
Check "objeto" (-not (Test-Effort "openai" ([pscustomobject]@{ value = "low" })))

# --- Sem interpolacao insegura via .cmd ----------------------

Check "cmd: aspas" (Throws { Assert-SafeCliArgument "codex.cmd" 'a"b' })
Check "cmd: %" (Throws { Assert-SafeCliArgument "codex.cmd" "%PATH%" })
Check "cmd: !" (Throws { Assert-SafeCliArgument "codex.cmd" "!x!" })
Check "cmd: & sem espaco" (Throws { Assert-SafeCliArgument "codex.cmd" "a&calc" })
Check "cmd: | sem espaco" (Throws { Assert-SafeCliArgument "codex.cmd" "a|calc" })
Check "cmd: > sem espaco" (Throws { Assert-SafeCliArgument "codex.cmd" "a>x.txt" })
Check "cmd: quebra de linha" (Throws { Assert-SafeCliArgument "codex.cmd" "a`r`ncalc" })
Check "bat tambem" (Throws { Assert-SafeCliArgument "x.bat" "a&b" })
Check "cmd: effort valido passa" (-not (Throws { Assert-SafeCliArgument "codex.cmd" "medium" }))
Check "cmd: texto com espaco passa" (-not (Throws { Assert-SafeCliArgument "codex.cmd" "a & b" }))
Check "exe nao e restringido" (-not (Throws { Assert-SafeCliArgument "claude.exe" 'a"b' }))

# --- Cache separado por effort -------------------------------

$keys = @("low", "medium", "high", $null) | ForEach-Object { Cache-Key "openai" "balanced" "gpt-x" $_ "b1" }
Check "cache: chaves distintas" ((@($keys | Select-Object -Unique)).Count -eq 4)
Check "cache: formato" ($keys[1] -ceq "openai|balanced|gpt-x|medium|b1")
Check "cache: sem effort = none" ($keys[3] -ceq "openai|balanced|gpt-x|none|b1")

# --- Argumentos Codex ----------------------------------------

$a = Get-OpenAICliArgs "gpt-x" "medium" "m.txt" "prompt"
Check "codex: args exatos" (($a -join " ") -ceq 'exec --ephemeral --skip-git-repo-check -c model_provider="openai" -c model_reasoning_effort="medium" -m gpt-x -o m.txt prompt')
Check "codex: sem low fixo" (-not ($a -ccontains 'model_reasoning_effort="low"'))
$a = Get-OpenAICliArgs "gpt-x" $null "m.txt" "prompt"
Check "codex: sem effort nao envia config" (-not ($a -match 'reasoning'))
Check "codex: effort invalido" (Throws { Get-OpenAICliArgs "gpt-x" "ultra" "m" "p" })
Check "codex: max invalido" (Throws { Get-OpenAICliArgs "gpt-x" "max" "m" "p" })

# --- Argumentos Claude ---------------------------------------

$a = Get-AnthropicCliArgs "claude-opus-5-5" "high" "prompt"
Check "claude: args exatos" (($a -join " ") -ceq "-p --model claude-opus-5-5 --effort high --settings claude-direct-settings.json --output-format json --no-session-persistence prompt")
$a = Get-AnthropicCliArgs "claude-opus-5-5" $null "prompt"
Check "claude: sem effort nao envia --effort" (-not ($a -ccontains "--effort"))
Check "claude: effort invalido" (Throws { Get-AnthropicCliArgs "claude-x" "minimal" "p" })
Check "Run-Model: effort invalido" (Throws { Run-Model "openai" "gpt-x" "turbo" "p" })
Check "Run-Model: modelo invalido" (Throws { Run-Model "openai" "gpt-x&calc" "low" "p" })
Check "Run-Model: effort de outro provider" (Throws { Run-Model "openai" "gpt-x" "max" "p" })

# --- Perfis do efforts.json versionado ------------------------

$EffortProfiles = ConvertTo-EffortProfiles ($effortsJson | ConvertFrom-Json)

$p = Get-EffortPlan "openai" "fast" "gpt-a" "gpt-b"
Check "plan openai fast baseline" ($p.baseline -ceq "low" -and $p.baselineSource -ceq "efforts.json")
Check "plan openai fast candidato" ($p.candidate.Count -eq 1 -and $p.candidate[0] -ceq "low")
$p = Get-EffortPlan "openai" "balanced" "gpt-a" "gpt-b"
Check "plan openai balanced" (($p.candidate -join ",") -ceq "low,medium")
$p = Get-EffortPlan "openai" "frontier" "gpt-a" "gpt-b"
Check "plan openai frontier" (($p.candidate -join ",") -ceq "medium,high")

# Haiku sem effort
$p = Get-EffortPlan "anthropic" "fast" "claude-haiku-4-5" "claude-haiku-5"
Check "haiku: sem effort" ($p.candidate.Count -eq 1 -and $null -eq $p.candidate[0] -and $null -eq $p.baseline)
Check "haiku: label" ((Get-EffortLabel "anthropic" "claude-haiku-5" $null) -ceq "not-applicable")
$p = Get-EffortPlan "anthropic" "balanced" "claude-sonnet-5" "claude-haiku-6"
Check "haiku: matriz deduplicada" ($p.candidate.Count -eq 1 -and $null -eq $p.candidate[0])
$p = Get-EffortPlan "anthropic" "frontier" "claude-opus-5-5" "claude-opus-6"
Check "claude frontier" (($p.candidate -join ",") -ceq "medium,high" -and $null -eq $p.baseline)
Check "claude cli-default" ((Get-EffortLabel "anthropic" "claude-opus-5-5" $null) -ceq "cli-default")

# --- Perfil malicioso / limites ------------------------------

$raw = '{"version":1,"providers":{"openai":{"supportsEffort":true,"baseline":{"fast":"bogus; calc"},"matrix":{"fast":["low","LOW","x\" -c a=b","low","medium","high","xhigh"],"balanced":"medium"}},"anthropic":{"supportsEffort":false,"modelsWithoutEffort":["claude-haiku-"],"matrix":{"balanced":["high"]}}}}' | ConvertFrom-Json
$script:logged = @()
$EffortProfiles = ConvertTo-EffortProfiles $raw
Check "matriz: invalidos descartados e limite 3" (($EffortProfiles.openai.matrix.fast -join ",") -ceq "low,medium,high")
Check "matriz: string unica aceita" (($EffortProfiles.openai.matrix.balanced -join ",") -ceq "medium")
Check "baseline invalido -> legado" ($EffortProfiles.openai.baseline.fast -ceq "low")
Check "baseline omitido -> legado" ($EffortProfiles.openai.baseline.frontier -ceq "low")
Check "aviso sem ecoar valor" (($script:logged -join "`n") -notmatch 'bogus|calc|a=b')
Check "aviso emitido" ($script:logged.Count -ge 2)

# Provider sem effort
Check "provider sem effort: desligado" (-not $EffortProfiles.anthropic.supportsEffort -and $EffortProfiles.anthropic.matrix.balanced.Count -eq 0)
$p = Get-EffortPlan "anthropic" "balanced" "claude-sonnet-5" "claude-sonnet-6"
Check "provider sem effort: nenhuma flag" ($p.candidate.Count -eq 1 -and $null -eq $p.candidate[0] -and $null -eq $p.baseline)
Check "provider sem effort: label" ((Get-EffortLabel "anthropic" "claude-sonnet-6" $null) -ceq "not-applicable")
Check "provider sem effort: cliente" ((Get-ClientEffortInfo "anthropic").effort -ceq "not-applicable")

Check "version invalida" (Throws { ConvertTo-EffortProfiles ('{"version":2}' | ConvertFrom-Json) })
Check "supportsEffort nao-bool" (Throws { ConvertTo-EffortProfiles ('{"version":1,"providers":{"openai":{"supportsEffort":"yes"}}}' | ConvertFrom-Json) })
Check "baselineFromClient nao-bool" (Throws { ConvertTo-EffortProfiles ('{"version":1,"providers":{"openai":{"supportsEffort":true,"baselineFromClient":"yes"}}}' | ConvertFrom-Json) })
$EffortProfiles = ConvertTo-EffortProfiles ('{"version":1,"providers":{"anthropic":{"supportsEffort":true,"modelsWithoutEffort":["gpt-","claude-x&y","claude-haiku-"]}}}' | ConvertFrom-Json)
Check "prefixos validados" (($EffortProfiles.anthropic.modelsWithoutEffort -join ",") -ceq "claude-haiku-")

# Compatibilidade: chave antiga "current" = baseline; "baseline" tem prioridade.
$EffortProfiles = ConvertTo-EffortProfiles ('{"version":1,"providers":{"openai":{"supportsEffort":true,"current":{"fast":"high"}}}}' | ConvertFrom-Json)
Check "compat: current aceito como baseline" ($EffortProfiles.openai.baseline.fast -ceq "high")
$EffortProfiles = ConvertTo-EffortProfiles ('{"version":1,"providers":{"openai":{"supportsEffort":true,"current":{"fast":"high"},"baseline":{"fast":"medium"}}}}' | ConvertFrom-Json)
Check "compat: baseline prevalece" ($EffortProfiles.openai.baseline.fast -ceq "medium")

# --- Modo legado (sem efforts.json) --------------------------

$EffortProfilesSource = "legacy-default"
$EffortProfiles = New-LegacyEffortProfiles
$p = Get-EffortPlan "openai" "balanced" "gpt-a" "gpt-b"
Check "legado openai" ($p.baseline -ceq "low" -and ($p.candidate -join ",") -ceq "low" -and $p.baselineSource -ceq "legacy-default")
$p = Get-EffortPlan "anthropic" "balanced" "claude-a" "claude-b"
Check "legado anthropic" ($null -eq $p.baseline -and $p.candidate.Count -eq 1 -and $null -eq $p.candidate[0])
$EffortProfilesSource = "efforts.json"

# --- Effort do cliente (client-efforts.json) -----------------

$EffortProfiles = ConvertTo-EffortProfiles ($effortsJson | ConvertFrom-Json)

$ClientEfforts = @{ "openai" = $null; "anthropic" = $null }
$info = Get-ClientEffortInfo "openai"
Check "cliente: desconhecido por padrao" ($info.effort -ceq "unknown" -and $info.source -ceq "unknown")
$p = Get-EffortPlan "openai" "balanced" "gpt-a" "gpt-b"
Check "cliente desconhecido: baseline fallback" ($p.baseline -ceq "low" -and $p.baselineSource -ceq "efforts.json")

$ClientEfforts = ConvertTo-ClientEfforts ('{"version":1,"providers":{"openai":{"effort":"medium"},"anthropic":{"effort":"high"}}}' | ConvertFrom-Json)
$info = Get-ClientEffortInfo "openai"
Check "cliente: declarado" ($info.effort -ceq "medium" -and $info.source -ceq "client-efforts.json")
$p = Get-EffortPlan "openai" "fast" "gpt-a" "gpt-b"
Check "cliente: baseline = effort do cliente" ($p.baseline -ceq "medium" -and $p.baselineSource -ceq "client-efforts.json")
Check "cliente: matriz nao muda" ($p.candidate.Count -eq 1 -and $p.candidate[0] -ceq "low")
$p = Get-EffortPlan "anthropic" "balanced" "claude-sonnet-5" "claude-sonnet-6"
Check "cliente anthropic: baseline high" ($p.baseline -ceq "high")
$p = Get-EffortPlan "anthropic" "fast" "claude-haiku-4-5" "claude-haiku-5"
Check "cliente anthropic: haiku continua sem effort" ($null -eq $p.baseline)

$EffortProfiles.openai.baselineFromClient = $false
$p = Get-EffortPlan "openai" "fast" "gpt-a" "gpt-b"
Check "baselineFromClient=false ignora cliente" ($p.baseline -ceq "low" -and $p.baselineSource -ceq "efforts.json")
Check "baselineFromClient=false ainda reporta cliente" ((Get-ClientEffortInfo "openai").effort -ceq "medium")

$script:logged = @()
$ClientEfforts = ConvertTo-ClientEfforts ('{"version":1,"providers":{"openai":{"effort":"medium & calc"},"anthropic":{"effort":"minimal"}}}' | ConvertFrom-Json)
Check "cliente malicioso: descartado" ($null -eq $ClientEfforts.openai -and $null -eq $ClientEfforts.anthropic)
Check "cliente malicioso: nao ecoado" (($script:logged -join "`n") -notmatch 'calc|minimal' -and $script:logged.Count -eq 2)
$ClientEfforts = ConvertTo-ClientEfforts ('{"version":9,"providers":{"openai":{"effort":"medium"}}}' | ConvertFrom-Json)
Check "cliente version invalida: desconhecido" ($null -eq $ClientEfforts.openai)
$ClientEfforts = @{ "openai" = $null; "anthropic" = $null }

# --- Recomendacao --------------------------------------------

function S($effort, $rank, $passed, $failures, $ms) {
    [ordered]@{ model = "c"; effort = $effort; effortRank = $rank; passed = $passed; total = 3; failures = $failures; averageMilliseconds = $ms }
}

$base = S "low" 0 3 0 1000
$best = Select-BestCombo @((S "medium" 1 3 0 800), (S "low" 0 3 0 900))
Check "empate: menor effort vence" ($best.effort -ceq "low")
Check "empate: status" ((Get-ComboStatus $base $best) -ceq "EMPATE-ETAPA-1")

$base = S "low" 0 2 0 1000
$best = Select-BestCombo @((S "low" 0 2 0 500), (S "medium" 1 3 0 1500))
Check "mais acertos vence menor effort" ($best.effort -ceq "medium" -and (Get-ComboStatus $base $best) -ceq "CANDIDATO-ETAPA-2")

$failing = S "low" 0 3 1 500
$best = Select-BestCombo @($failing, (S "medium" 1 3 0 1500))
Check "falha de execucao penaliza" ($best.effort -ceq "medium")
Check "falha: status" ((Get-ComboStatus $base $failing) -ceq "MANTER-ATUAL-CANDIDATO-FALHOU")

$base = S "low" 0 3 0 1000
$fast = S "low" 0 3 0 700
Check "mesmo effort: menor latencia" ((Select-BestCombo @($fast, (S "low2" 0 3 0 600))).effort -ceq "low2")
Check "mais rapido: etapa 2" ((Get-ComboStatus $base $fast) -ceq "CANDIDATO-ETAPA-2")
Check "pior: manter" ((Get-ComboStatus $base (S "low" 0 2 0 100)) -ceq "MANTER-ATUAL")

$unitCount = $script:count
$unitFail = $script:fail
Write-Host "unidades: $unitCount casos, $unitFail falha(s)"

# ============================================================
# Integracao: copia temporaria + CLIs falsos
# ============================================================

$tmp = Join-Path $env:TEMP ("jev-effort-test-" + [guid]::NewGuid().ToString())
$lab = Join-Path $tmp "model-lab"
$binDir = Join-Path $tmp "bin"

$script:count = 0
$script:fail = 0

try {

    New-Item -ItemType Directory -Force $lab, (Join-Path $tmp "runtime"), $binDir | Out-Null

    foreach ($f in "benchmark.ps1", "cases.json", "efforts.json", "claude-direct-settings.json") {
        Copy-Item (Join-Path $Src $f) $lab
    }

    # CLIs falsos: registram os argumentos exatamente como o cmd.exe os
    # recebe e terminam com sucesso. Nunca acessam rede.
    $fakeCodex = Join-Path $binDir "codex.cmd"
    $fakeClaude = Join-Path $binDir "claude.cmd"
    Set-Content $fakeCodex "@echo off`r`necho %*>>`"%~dp0codex-args.txt`"`r`nexit /b 0" -Encoding ASCII
    Set-Content $fakeClaude "@echo off`r`necho %*>>`"%~dp0claude-args.txt`"`r`necho {`"result`":`"x`"}`r`nexit /b 0" -Encoding ASCII
    @{ codex = $fakeCodex; claude = $fakeClaude } |
        ConvertTo-Json |
        Set-Content (Join-Path $tmp "runtime\runtime-paths.json") -Encoding UTF8

    $bench = Join-Path $lab "benchmark.ps1"
    $pendingFile = Join-Path $lab "pending-models.json"
    $cacheFile = Join-Path $lab "benchmark-cache.json"
    $clientFile = Join-Path $lab "client-efforts.json"
    $reportsDir = Join-Path $lab "reports"
    $codexArgsFile = Join-Path $binDir "codex-args.txt"
    $claudeArgsFile = Join-Path $binDir "claude-args.txt"

    # Se algum valor fosse interpolado pelo cmd.exe, este arquivo surgiria.
    $canary = Join-Path $tmp "pwned.txt"

    function Run-Bench([switch]$Dry) {
        $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $bench)
        if ($Dry) { $argList += "-DryRun" }
        $out = & powershell.exe @argList 2>&1 | Out-String
        return @{ out = $out; code = $LASTEXITCODE }
    }

    function Reset-Lab {
        Remove-Item $cacheFile, $clientFile, $codexArgsFile, $claudeArgsFile -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $reportsDir "*") -Force -ErrorAction SilentlyContinue
        Copy-Item (Join-Path $Src "efforts.json") $lab -Force
    }

    function Get-Report {
        return (Get-ChildItem $reportsDir -Filter *.json | Select-Object -First 1 | Get-Content -Raw | ConvertFrom-Json)
    }

    $openaiPending = '[{"provider":"openai","tier":"balanced","candidate":"gpt-new","current":"gpt-6.1-sol","status":"pending-benchmark"}]'

    # 1. Fila vazia: zero chamadas, mesmo fora do DryRun
    "[]" | Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench
    Check "fila vazia: exit 0" ($r.code -eq 0)
    Check "fila vazia: mensagem" ($r.out -match 'Zero chamadas')
    Check "fila vazia: nenhuma CLI" (-not (Test-Path $codexArgsFile) -and -not (Test-Path $claudeArgsFile))
    Check "fila vazia: sem cache" (-not (Test-Path $cacheFile))

    # 2. DryRun OpenAI balanced: baseline low x3 + low x3 + medium x3
    $openaiPending | Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench -Dry
    Check "dry: exit 0" ($r.code -eq 0)
    Check "dry: 9 chamadas" ($r.out -match '9 chamada\(s\)')
    Check "dry: modelo atual do router" ($r.out -match 'Modelo atual do router: gpt-6.1-sol')
    Check "dry: baseline low (efforts.json)" ($r.out -match 'Effort baseline:\s+low \(origem: efforts.json\)')
    Check "dry: cliente desconhecido" ($r.out -match 'Effort do cliente:\s+unknown \(origem: unknown\)')
    Check "dry: chamaria baseline low" ($r.out -match 'chamaria openai / gpt-6.1-sol / effort=low')
    Check "dry: chamaria medium" ($r.out -match 'chamaria openai / gpt-new / effort=medium')
    Check "dry: args medium" ($r.out -match 'model_reasoning_effort="medium" -m gpt-new')
    Check "dry: sem high" ($r.out -notmatch 'effort=high')
    Check "dry: nenhuma CLI" (-not (Test-Path $codexArgsFile))
    Check "dry: pendencia intacta" ((Get-Content $pendingFile -Raw).Trim() -ceq $openaiPending)
    Check "dry: sem cache" (-not (Test-Path $cacheFile))
    Check "dry: sem relatorio" (@(Get-ChildItem $reportsDir -File -ErrorAction SilentlyContinue).Count -eq 0)

    # 3. DryRun com effort do cliente declarado: baseline passa a ser medium
    '{"version":1,"providers":{"openai":{"effort":"medium"}}}' | Set-Content $clientFile -Encoding UTF8
    $r = Run-Bench -Dry
    Check "dry cliente: baseline medium" ($r.out -match 'Effort baseline:\s+medium \(origem: client-efforts.json\)')
    Check "dry cliente: cliente medium" ($r.out -match 'Effort do cliente:\s+medium \(origem: client-efforts.json\)')
    Check "dry cliente: chamaria baseline medium" ($r.out -match 'chamaria openai / gpt-6.1-sol / effort=medium')
    Check "dry cliente: baseline nao usa low" ($r.out -notmatch 'chamaria openai / gpt-6.1-sol / effort=low')
    Reset-Lab

    # 4. Cache: low em cache nao cobre medium; chave antiga migra para low
    $caseIds = @((Get-Content (Join-Path $Src "cases.json") -Raw | ConvertFrom-Json).balanced |
        Select-Object -First 3 | ForEach-Object { $_.id })
    $cacheItems = @()
    foreach ($id in $caseIds) {
        $cacheItems += [ordered]@{ key = "openai|balanced|gpt-new|low|$id"; provider = "openai"; tier = "balanced"; model = "gpt-new"; effort = "low"; caseId = $id; success = $true; passed = $true; milliseconds = 10; answer = "x"; error = "" }
        $cacheItems += [ordered]@{ key = "openai|balanced|gpt-6.1-sol|$id"; provider = "openai"; tier = "balanced"; model = "gpt-6.1-sol"; caseId = $id; success = $true; passed = $true; milliseconds = 10; answer = "x"; error = "" }
    }
    $cacheItems | ConvertTo-Json | Set-Content $cacheFile -Encoding UTF8
    $cacheBefore = Get-Content $cacheFile -Raw
    $r = Run-Bench -Dry
    Check "cache: so medium seria chamado" ($r.out -match '3 chamada\(s\)')
    Check "cache: low reaproveitado" ($r.out -match 'CACHE: openai / gpt-new / effort=low')
    Check "cache: medium nao reaproveita low" ($r.out -match 'chamaria openai / gpt-new / effort=medium')
    Check "cache: chave antiga migrada" ($r.out -match 'CACHE: openai / gpt-6.1-sol / effort=low' -and $r.out -match 'convertida')
    Check "cache: dry nao grava" ((Get-Content $cacheFile -Raw) -ceq $cacheBefore)
    Reset-Lab

    # 5. Anthropic: haiku sem --effort; sonnet baseline cli-default
    '[{"provider":"anthropic","tier":"fast","candidate":"claude-haiku-5","current":"claude-haiku-4-5"},{"provider":"anthropic","tier":"balanced","candidate":"claude-sonnet-6","current":"claude-sonnet-5"}]' |
        Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench -Dry
    Check "anthropic: haiku not-applicable" ($r.out -match 'chamaria anthropic / claude-haiku-5 / effort=not-applicable')
    Check "anthropic: baseline cli-default" ($r.out -match 'chamaria anthropic / claude-sonnet-5 / effort=cli-default')
    Check "anthropic: --effort medium" ($r.out -match '--model claude-sonnet-6 --effort medium')
    $haikuArgs = @($r.out -split "`n" | Where-Object { $_ -match 'args: -p --model claude-haiku' })
    Check "anthropic: haiku sem flag" ($haikuArgs.Count -eq 6 -and -not ($haikuArgs -match '--effort'))
    Check "anthropic: 15 chamadas" ($r.out -match '15 chamada\(s\)')

    # 6. Provider sem effort: nenhuma flag
    $off = Get-Content (Join-Path $lab "efforts.json") -Raw | ConvertFrom-Json
    $off.providers.anthropic.supportsEffort = $false
    $off | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $lab "efforts.json") -Encoding UTF8
    $r = Run-Bench -Dry
    Check "sem effort: nenhum --effort" ($r.out -notmatch '--effort')
    Check "sem effort: not-applicable" ($r.out -match 'chamaria anthropic / claude-sonnet-6 / effort=not-applicable')
    # haiku 3+3, sonnet 3+3 (matriz colapsa em uma combinacao sem flag)
    Check "sem effort: 12 chamadas" ($r.out -match '12 chamada\(s\)')
    Reset-Lab

    # 7. Valores maliciosos em efforts.json e client-efforts.json
    $evil = Get-Content (Join-Path $lab "efforts.json") -Raw | ConvertFrom-Json
    $evil.providers.openai.matrix.balanced = @(
        'medium" -c sandbox_mode="danger-full-access',
        "medium & echo x>`"$canary`"",
        "high"
    )
    $evil | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $lab "efforts.json") -Encoding UTF8
    '{"version":1,"providers":{"openai":{"effort":"low & echo x>pwned.txt"}}}' | Set-Content $clientFile -Encoding UTF8
    $openaiPending | Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench -Dry
    Check "malicioso: nao ecoado" ($r.out -notmatch 'sandbox_mode|echo x|pwned')
    Check "malicioso: aviso" ($r.out -match 'descartado' -and $r.out -match 'client-efforts.json \(openai\): effort invalido')
    Check "malicioso: so high" ($r.out -match 'effort=high' -and $r.out -notmatch 'chamaria openai / gpt-new / effort=medium')
    Check "malicioso: cliente desconhecido" ($r.out -match 'Effort do cliente:\s+unknown')
    $r = Run-Bench
    $recv = @(Get-Content $codexArgsFile)
    Check "malicioso real: CLI recebeu so allowlist" (($recv -join "`n") -notmatch 'sandbox|echo|pwned' -and @($recv | Where-Object { $_ -match 'model_reasoning_effort="high"' }).Count -eq 3)
    Check "malicioso real: sem interpolacao no cmd.exe" (-not (Test-Path $canary) -and -not (Test-Path (Join-Path $lab "pwned.txt")) -and -not (Test-Path (Join-Path $tmp "pwned.txt")))
    Reset-Lab

    # 8. Modelo malicioso na fila nunca chega a CLI
    '[{"provider":"openai","tier":"balanced","candidate":"gpt-x&echo","current":"gpt-6.1-sol"}]' | Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench
    Check "modelo malicioso: rejeitado" ($r.out -match 'nome fora do formato permitido' -and $r.out -notmatch 'gpt-x&echo')
    Check "modelo malicioso: nenhuma CLI" (-not (Test-Path $codexArgsFile))
    Reset-Lab

    # 9. Sem efforts.json: modo legado (low para baseline e candidato)
    Remove-Item (Join-Path $lab "efforts.json")
    $openaiPending | Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench -Dry
    Check "legado: aviso" ($r.out -match 'efforts.json ausente')
    Check "legado: 6 chamadas low" ($r.out -match '6 chamada\(s\)' -and $r.out -notmatch 'effort=medium')
    Check "legado: origem" ($r.out -match 'Effort baseline:\s+low \(origem: legacy-default\)')
    Reset-Lab

    # 10. Execucao com CLI falso (Codex): argumentos exatos e relatorio
    $openaiPending | Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench
    Check "codex falso: exit 0" ($r.code -eq 0)
    $recv = @(Get-Content $codexArgsFile)
    $argPattern = '^exec --ephemeral --skip-git-repo-check -c model_provider="openai" -c model_reasoning_effort="{0}" -m {1} -o \S+ '
    Check "codex falso: 9 chamadas" ($recv.Count -eq 9)
    Check "codex falso: candidato medium exato" (@($recv | Where-Object { $_ -cmatch ($argPattern -f "medium", "gpt-new") }).Count -eq 3)
    Check "codex falso: candidato low exato" (@($recv | Where-Object { $_ -cmatch ($argPattern -f "low", "gpt-new") }).Count -eq 3)
    Check "codex falso: baseline low exato" (@($recv | Where-Object { $_ -cmatch ($argPattern -f "low", "gpt-6\.1-sol") }).Count -eq 3)
    Check "codex falso: um effort por chamada" (@($recv | Where-Object { ([regex]::Matches($_, 'model_reasoning_effort')).Count -ne 1 }).Count -eq 0)
    Check "pendencia consumida" ((Get-Content $pendingFile -Raw).Trim() -ceq "[]")
    $cache = Get-Content $cacheFile -Raw | ConvertFrom-Json
    Check "cache: 9 entradas" (@($cache).Count -eq 9)
    Check "cache: effort separado" (@($cache | Where-Object { $_.key -like "openai|balanced|gpt-new|medium|*" }).Count -eq 3)

    $report = Get-Report
    Check "relatorio: modelo atual do router" ($report.routerTierModel -ceq "gpt-6.1-sol")
    Check "relatorio: baseline" ($report.efforts.baseline.effort -ceq "low" -and $report.efforts.baseline.source -ceq "efforts.json")
    Check "relatorio: cliente desconhecido" ($report.efforts.client.effort -ceq "unknown" -and $report.efforts.client.source -ceq "unknown")
    Check "relatorio: comparacao com cliente nula" ($null -eq $report.efforts.baselineMatchesClient)
    Check "relatorio: recomendado nao aplicado" ($report.efforts.recommended.applied -eq $false -and $report.efforts.recommended.model -ceq "gpt-new")
    $rec = $report.efforts.recommended
    Check "relatorio: recomendado provider/tier" ($rec.provider -ceq $report.provider -and $rec.tier -ceq $report.tier)
    Check "relatorio: recomendado configPath" ($rec.configPath -ceq "surfaces.$($report.provider).$($report.tier)")
    Check "relatorio: recomendado configPatch" ($rec.configPatch.model -ceq "gpt-new" -and $rec.configPatch.effort -ceq $rec.effort -and @($rec.configPatch.PSObject.Properties.Name).Count -eq 2)
    Check "relatorio: sem campo current" ($null -eq $report.PSObject.Properties["current"])
    Check "relatorio: resumo baseline" ($report.baseline.effort -ceq "low" -and $report.baseline.model -ceq "gpt-6.1-sol")
    Check "relatorio: 2 combinacoes" (@($report.candidates).Count -eq 2)
    Check "relatorio: versusBaseline" ($null -ne $report.candidates[0].versusBaseline)
    Check "relatorio: resultados com effort" (@($report.results.candidate | Where-Object { $_.effort -ceq "medium" }).Count -eq 3)
    Check "relatorio: resultados baseline" (@($report.results.baseline).Count -eq 3)
    Check "relatorio: etapa 2 nao implementada" ($report.stage -eq 1 -and $report.stage2.implemented -eq $false)
    Check "relatorio: nota sem 'aplicar'" ($report.note -match 'nao foi aplicad')
    # Respostas vazias: nada passa; empate em 0/3 -> menor effort, sem promocao.
    Check "relatorio: melhor = low" ($report.candidate.effort -ceq "low" -and $report.efforts.recommended.effort -ceq "low" -and $report.recommendation -ceq "INCONCLUSIVO")
    Check "relatorio: sem promocao" (@($report.stage2.candidates).Count -eq 0)
    Reset-Lab

    # 11. Execucao com cliente declarado: baseline e relatorio refletem o cliente
    '{"version":1,"providers":{"openai":{"effort":"medium"}}}' | Set-Content $clientFile -Encoding UTF8
    $openaiPending | Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench
    $recv = @(Get-Content $codexArgsFile)
    Check "cliente real: baseline medium exato" (@($recv | Where-Object { $_ -cmatch ($argPattern -f "medium", "gpt-6\.1-sol") }).Count -eq 3)
    $report = Get-Report
    Check "cliente real: baseline" ($report.efforts.baseline.effort -ceq "medium" -and $report.efforts.baseline.source -ceq "client-efforts.json")
    Check "cliente real: cliente" ($report.efforts.client.effort -ceq "medium" -and $report.efforts.baseline.effort -ceq $report.efforts.client.effort)
    Check "cliente real: baseline = cliente" ($report.efforts.baselineMatchesClient -eq $true)
    Reset-Lab

    # 12. Execucao com CLI falso (Claude): --effort exato, haiku sem flag
    '[{"provider":"anthropic","tier":"fast","candidate":"claude-haiku-5","current":"claude-haiku-4-5"},{"provider":"anthropic","tier":"balanced","candidate":"claude-sonnet-6","current":"claude-sonnet-5"}]' |
        Set-Content $pendingFile -Encoding UTF8
    $r = Run-Bench
    $recv = @(Get-Content $claudeArgsFile)
    Check "claude falso: 15 chamadas" ($recv.Count -eq 15)
    Check "claude falso: --effort medium exato" (@($recv | Where-Object { $_ -cmatch '^-p --model claude-sonnet-6 --effort medium --settings \S+ --output-format json --no-session-persistence ' }).Count -eq 3)
    Check "claude falso: baseline sem --effort" (@($recv | Where-Object { $_ -cmatch '^-p --model claude-sonnet-5 --settings ' }).Count -eq 3)
    Check "claude falso: haiku sem --effort" (@($recv | Where-Object { $_ -match 'claude-haiku' -and $_ -match '--effort' }).Count -eq 0)
    $reports = @(Get-ChildItem $reportsDir -Filter *.json | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json })
    $haikuReport = $reports | Where-Object { $_.tier -eq "fast" }
    Check "claude falso: relatorio haiku" ($haikuReport.efforts.baseline.effort -ceq "not-applicable" -and $null -eq $haikuReport.efforts.recommended.effort -and $null -eq $haikuReport.efforts.recommended.configPatch.effort -and $haikuReport.efforts.recommended.configPatch.model -ceq $haikuReport.efforts.recommended.model)
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "integracao: $script:count casos, $script:fail falha(s)"

if ($unitFail -gt 0 -or $script:fail -gt 0) {
    exit 1
}

Write-Host "OK"
