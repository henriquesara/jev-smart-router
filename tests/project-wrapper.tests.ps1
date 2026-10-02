# Testes da identificacao de projeto nos wrappers (bin\project.ps1 e
# Write-CliWrapper de scripts\install.ps1).
#
# Nao chama Claude, Codex nem o router: os wrappers sao gerados numa pasta
# temporaria apontando para um CLI falso (.exe compilado aqui) que so registra
# os argumentos recebidos e as variaveis JEV_*.
#
# Uso (na raiz do projeto):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\project-wrapper.tests.ps1
#
# Sai com codigo 1 se algum teste falhar. Arquivos temporarios ficam em
# %TEMP%\jev-project-test-<guid> e sao removidos ao final.

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

$script:fail = 0
$script:count = 0

function Check($Name, $Cond) {
    $script:count++
    if (-not $Cond) {
        $script:fail++
        Write-Host "FALHOU: $Name"
    }
}

function Expected-Id([string]$Normalized) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Normalized))
    $sha.Dispose()
    return (-join ($hash[0..5] | ForEach-Object { $_.ToString("x2") }))
}

# ============================================================
# Unidades: bin\project.ps1
# ============================================================

. (Join-Path $Root "bin\project.ps1")

Check "nome: basename simples" ((Get-ProjectName "C:/work/finance-api") -eq "finance-api")
Check "nome: caracteres fora de [A-Za-z0-9._-] viram -" ((Get-ProjectName "C:\work\Meu Projeto (v2)") -eq "Meu-Projeto--v2-")
Check "nome: acentos viram -" ((Get-ProjectName "C:\work\ação") -eq "a--o")
Check "nome: .. vira ." ((Get-ProjectName "C:\work\a..b") -eq "a.b")
Check "nome: so pontos vira project" ((Get-ProjectName "C:\work\...") -eq "project")
Check "nome: raiz de drive vira project" ((Get-ProjectName "C:\") -eq "project")
Check "nome: ate 40 caracteres" ((Get-ProjectName ("C:\w\" + ("x" * 60))).Length -eq 40)
Check "nome: barra final ignorada" ((Get-ProjectName "C:/work/alpha/") -eq "alpha")

Check "raiz: separador /, minusculo, sem barra final" ((Get-NormalizedRoot "C:\Work\Alpha\") -eq "c:/work/alpha")
Check "raiz: / e \ dao o mesmo resultado" ((Get-NormalizedRoot "C:/Work/Alpha") -eq (Get-NormalizedRoot "c:\work\alpha"))

Check "id: 12 hex do SHA-256 da raiz normalizada" ((Get-ProjectId "c:/work/alpha") -eq (Expected-Id "c:/work/alpha"))
Check "id: formato" ((Get-ProjectId "c:/x") -cmatch '^[0-9a-f]{12}$')

$ids = 1..50 | ForEach-Object { New-InstanceId }
Check "instancia: 10 caracteres [a-z0-9]" (@($ids | Where-Object { $_ -cnotmatch '^[a-z0-9]{10}$' }).Count -eq 0)
Check "instancia: nova a cada chamada" (@($ids | Sort-Object -Unique).Count -eq 50)

Check "settings: ausente" (-not (Test-UserSettings '-p "oi" --model sonnet'))
Check "settings: vazio" (-not (Test-UserSettings ''))
Check "settings: --settings arquivo" (Test-UserSettings '-p oi --settings x.json')
Check "settings: --settings=arquivo" (Test-UserSettings '--settings=x.json')
Check "settings: entre aspas" (Test-UserSettings '"--settings" "{}"')
Check "settings: --settings-foo nao conta" (-not (Test-UserSettings '--settings-foo 1'))
Check "settings A: mencionado no prompt nao conta" (-not (Test-UserSettings '-p "explique o que --settings faz"'))
Check "settings B: --settings arquivo antes do prompt" (Test-UserSettings '--settings some-settings.json -p "teste"')
Check "settings C: --settings=arquivo antes do prompt" (Test-UserSettings '--settings=some-settings.json -p "teste"')
Check "settings D: prompt entre aspas igual a --settings nao conta" (-not (Test-UserSettings '-p "--settings"'))
Check "settings E: --settings= dentro do prompt nao conta" (-not (Test-UserSettings '-p "abc --settings=xyz"'))
Check "settings: --print com o prompt --settings nao conta" (-not (Test-UserSettings '--print "--settings"'))
Check "settings: -p seguido de --settings sem aspas conta" (Test-UserSettings '-p --settings x.json "oi"')
Check "settings: --settings= com valor entre aspas conta" (Test-UserSettings '--settings="a b.json" -p oi')
Check "settings: outro argumento que so menciona nao conta" (-not (Test-UserSettings '--append-system-prompt "use --settings" -p oi'))
Check "settings: aspa escapada nao fecha o argumento" (-not (Test-UserSettings '-p "x\" --settings y"'))
Check "settings: maiusculas nao contam" (-not (Test-UserSettings '--SETTINGS x.json'))

$split = @(Split-CliArgs '-p "a b" x\"y "c\\" "q""r" 	tab')
Check "split: regras do CRT" ((($split | ForEach-Object { $_.Text }) -join "|") -ceq '-p|a b|x"y|c\|q"r|tab')
Check "split: marca argumento entre aspas" (-not $split[0].Quoted -and $split[1].Quoted)

# ============================================================
# Integracao: wrappers gerados por Write-CliWrapper
# ============================================================

$tmp = Join-Path $env:TEMP ("jev-project-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    # CLI falso: registra argv e as variaveis JEV_* em FAKE_OUT, sai com FAKE_EXIT.
    $fakeExe = Join-Path $tmp "fake-cli.exe"
    Add-Type -OutputType ConsoleApplication -OutputAssembly $fakeExe -TypeDefinition @'
using System;
using System.IO;
using System.Text;
public static class FakeCli {
    public static int Main(string[] args) {
        var sb = new StringBuilder();
        foreach (var a in args) sb.Append("ARG:").Append(a.Replace("\n", "\\n")).Append('\n');
        foreach (var n in new[] { "JEV_PROJECT_NAME", "JEV_PROJECT_ID", "JEV_INSTANCE_ID", "JEV_PROJECT_FLAG", "JEV_CLI_ARGS" })
            sb.Append("ENV:").Append(n).Append('=').Append(Environment.GetEnvironmentVariable(n) ?? "<unset>").Append('\n');
        sb.Append("CWD:").Append(Environment.CurrentDirectory).Append('\n');
        File.WriteAllText(Environment.GetEnvironmentVariable("FAKE_OUT"), sb.ToString(), new UTF8Encoding(false));
        int code;
        return int.TryParse(Environment.GetEnvironmentVariable("FAKE_EXIT"), out code) ? code : 0;
    }
}
'@

    # Write-CliWrapper e $RouterBaseUrl extraidos de install.ps1 via AST.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $Root "scripts\install.ps1"), [ref]$null, [ref]$null
    )
    $defs = ""
    foreach ($a in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Parent.Parent -eq $ast }, $false)) {
        if ($a.Extent.Text -match '^\$RouterBaseUrl\s*=') { $defs += $a.Extent.Text + "`n" }
    }
    foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "Write-CliWrapper" }, $true)) {
        $defs += $f.Extent.Text + "`n"
    }
    . ([scriptblock]::Create($defs))
    Check "install.ps1 define RouterBaseUrl" ($RouterBaseUrl -eq "http://127.0.0.1:4000")

    $bin = Join-Path $tmp "bin"
    New-Item -ItemType Directory -Path $bin | Out-Null
    Copy-Item (Join-Path $Root "bin\project.ps1") $bin
    Set-Content (Join-Path $bin "preflight.ps1") -Value 'exit 0' -Encoding ASCII
    Write-CliWrapper -CliName "claude" -RealPath $fakeExe -Destination (Join-Path $bin "claude.cmd")
    Write-CliWrapper -CliName "codex" -RealPath $fakeExe -Destination (Join-Path $bin "codex.cmd")

    # Projetos: alpha (repositorio git, com subpasta) e beta (pasta comum).
    $alpha = Join-Path $tmp "project-alpha"
    $alphaSub = Join-Path $alpha "src\deep"
    $beta = Join-Path $tmp "Project Beta"
    New-Item -ItemType Directory -Path $alphaSub, $beta | Out-Null
    & git -C $alpha init -q 2>$null | Out-Null
    $alphaId = Expected-Id (Get-NormalizedRoot $alpha)
    $betaId = Expected-Id (Get-NormalizedRoot $beta)

    $out = Join-Path $tmp "out.txt"

    # Executa um wrapper via cmd.exe com a linha de comando exata.
    function Invoke-Wrapper([string]$Cli, [string]$Cwd, [string]$ArgLine, [int]$Exit = 0) {
        if (Test-Path $out) { Remove-Item $out }
        $env:FAKE_OUT = $out
        $env:FAKE_EXIT = "$Exit"
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = '/d /c ""' + (Join-Path $bin "$Cli.cmd") + '" ' + $ArgLine + '"'
        $psi.WorkingDirectory = $Cwd
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $stdout = $p.StandardOutput.ReadToEnd()
        [void]$p.StandardError.ReadToEnd()
        $p.WaitForExit()
        $lines = if (Test-Path $out) { @(Get-Content $out -Encoding UTF8) } else { @() }
        $envs = @{}
        foreach ($l in $lines) {
            if ($l.StartsWith("ENV:")) {
                $kv = $l.Substring(4).Split([char[]]"=", 2)
                $envs[$kv[0]] = $kv[1]
            }
        }
        return [pscustomobject]@{
            Exit = $p.ExitCode
            Stdout = $stdout
            Args = @($lines | Where-Object { $_.StartsWith("ARG:") } | ForEach-Object { $_.Substring(4) })
            Env = $envs
            Raw = ($lines -join "`n")
        }
    }

    $userArgs = '-p "hello & bye | x" --model sonnet "a b" "x\"y"'
    $userExpected = @("-p", "hello & bye | x", "--model", "sonnet", "a b", 'x"y')

    # --- claude ---
    $r = Invoke-Wrapper "claude" $alpha $userArgs
    Check "claude: exit 0" ($r.Exit -eq 0)
    Check "claude: --settings injetado primeiro" ($r.Args.Count -eq 8 -and $r.Args[0] -eq "--settings")
    $settings = $null
    try { $settings = $r.Args[1] | ConvertFrom-Json } catch { }
    $url = if ($settings) { $settings.env.ANTHROPIC_BASE_URL } else { "" }
    Check "claude: settings so com env.ANTHROPIC_BASE_URL" ($settings -and @($settings.PSObject.Properties).Count -eq 1 -and @($settings.env.PSObject.Properties).Count -eq 1)
    Check "claude: URL com prefixo do projeto" ($url -cmatch "^http://127\.0\.0\.1:4000/_jev/project-alpha/$alphaId/[a-z0-9]{10}$")
    Check "claude: args do usuario preservados, na ordem" (($r.Args[2..7] -join "|") -ceq ($userExpected -join "|"))
    Check "claude: JEV_CLI_ARGS nao vaza para o CLI" ($r.Env["JEV_CLI_ARGS"] -eq "<unset>")
    Check "claude: nenhum caminho local nos args" (-not ($r.Args -join " ").Contains($tmp) -and -not ($r.Args -join " ").ToLowerInvariant().Contains($tmp.ToLowerInvariant().Replace('\', '/')))
    Check "claude: nada impresso pelo wrapper" ([string]::IsNullOrWhiteSpace($r.Stdout))

    $r2 = Invoke-Wrapper "claude" $alphaSub ""
    $url2 = ($r2.Args[1] | ConvertFrom-Json).env.ANTHROPIC_BASE_URL
    Check "claude: subpasta usa a raiz do repositorio" ($url2 -cmatch "/_jev/project-alpha/$alphaId/")
    Check "claude: sem args do usuario" ($r2.Args.Count -eq 2)
    Check "claude: instancia nova a cada processo" ($url2.Split("/")[-1] -ne $url.Split("/")[-1])

    $r3 = Invoke-Wrapper "claude" $beta "-p oi"
    $url3 = ($r3.Args[1] | ConvertFrom-Json).env.ANTHROPIC_BASE_URL
    Check "claude: fora de git usa a pasta atual, nome sanitizado" ($url3 -cmatch "/_jev/Project-Beta/$betaId/[a-z0-9]{10}$")

    $userSettings = @(
        @{ Line = '--settings my.json -p oi'; Expected = "--settings|my.json|-p|oi" },
        @{ Line = '-p oi --settings=my.json'; Expected = "-p|oi|--settings=my.json" },
        @{ Line = '"--settings" "{}"'; Expected = "--settings|{}" }
    )
    foreach ($case in $userSettings) {
        $r4 = Invoke-Wrapper "claude" $alpha $case.Line
        Check "claude: --settings do usuario, args intactos ($($case.Line))" (($r4.Args -join "|") -ceq $case.Expected)
        Check "claude: --settings do usuario, sem variaveis JEV ($($case.Line))" ($r4.Env["JEV_PROJECT_ID"] -eq "<unset>")
    }

    # --settings so como texto: injeta; como flag real: nao injeta. Args sempre intactos.
    $settingsCases = @(
        @{ Id = "A"; Line = '-p "explique o que --settings faz"'; Expected = "-p|explique o que --settings faz"; Inject = $true },
        @{ Id = "B"; Line = '--settings some-settings.json -p "teste"'; Expected = "--settings|some-settings.json|-p|teste"; Inject = $false },
        @{ Id = "C"; Line = '--settings=some-settings.json -p "teste"'; Expected = "--settings=some-settings.json|-p|teste"; Inject = $false },
        @{ Id = "D"; Line = '-p "--settings"'; Expected = "-p|--settings"; Inject = $true },
        @{ Id = "E"; Line = '-p "abc --settings=xyz"'; Expected = "-p|abc --settings=xyz"; Inject = $true }
    )
    foreach ($case in $settingsCases) {
        $rs = Invoke-Wrapper "claude" $alpha $case.Line
        $label = "claude $($case.Id) ($($case.Line))"
        if ($case.Inject) {
            $urlS = ""
            try { $urlS = ($rs.Args[1] | ConvertFrom-Json).env.ANTHROPIC_BASE_URL } catch { }
            Check "${label}: metadata injetada" ($rs.Args[0] -ceq "--settings" -and $urlS -cmatch "^http://127\.0\.0\.1:4000/_jev/project-alpha/$alphaId/[a-z0-9]{10}$")
            Check "${label}: args do usuario intactos depois" (($rs.Args[2..($rs.Args.Count - 1)] -join "|") -ceq $case.Expected)
        }
        else {
            Check "${label}: metadata nao injetada, args intactos" (($rs.Args -join "|") -ceq $case.Expected)
            Check "${label}: sem variaveis JEV" ($rs.Env["JEV_PROJECT_ID"] -eq "<unset>" -and -not $rs.Raw.Contains("/_jev/"))
        }
        Check "${label}: exit 0" ($rs.Exit -eq 0)
    }

    $r5 = Invoke-Wrapper "claude" $alpha "-p oi" 7
    Check "claude: exit code preservado" ($r5.Exit -eq 7)

    # --- codex ---
    $c = Invoke-Wrapper "codex" $alpha ('exec --skip-git-repo-check "diga oi & tchau"')
    Check "codex: exit 0" ($c.Exit -eq 0)
    Check "codex: -c env_http_headers primeiro" ($c.Args[0] -eq "-c" -and $c.Args[1] -ceq "model_providers.jev.env_http_headers={'x-jev-project-name'='JEV_PROJECT_NAME','x-jev-project-id'='JEV_PROJECT_ID','x-jev-instance-id'='JEV_INSTANCE_ID'}")
    Check "codex: args do usuario preservados" (($c.Args[2..4] -join "|") -ceq "exec|--skip-git-repo-check|diga oi & tchau" -and $c.Args.Count -eq 5)
    Check "codex: variaveis do processo" ($c.Env["JEV_PROJECT_NAME"] -ceq "project-alpha" -and $c.Env["JEV_PROJECT_ID"] -ceq $alphaId -and $c.Env["JEV_INSTANCE_ID"] -cmatch '^[a-z0-9]{10}$')
    Check "codex: nenhum token ou caminho nos args" (-not ($c.Args -join " ").Contains($tmp))

    $env:JEV_PROJECT_NAME = "stale"
    $env:JEV_PROJECT_ID = "000000000000"
    $env:JEV_INSTANCE_ID = "stale0000"
    try {
        $c2 = Invoke-Wrapper "codex" $beta "--version" 3
    }
    finally {
        Remove-Item Env:JEV_PROJECT_NAME, Env:JEV_PROJECT_ID, Env:JEV_INSTANCE_ID
    }
    Check "codex: valores herdados sao substituidos" ($c2.Env["JEV_PROJECT_NAME"] -ceq "Project-Beta" -and $c2.Env["JEV_PROJECT_ID"] -ceq $betaId)
    Check "codex: exit code preservado" ($c2.Exit -eq 3)

    # --- project.ps1 indisponivel: chamada exatamente como antes ---
    Rename-Item (Join-Path $bin "project.ps1") "project.ps1.off"
    $env:JEV_PROJECT_ID = "000000000000"
    try {
        $f1 = Invoke-Wrapper "claude" $alpha $userArgs 5
        $f2 = Invoke-Wrapper "codex" $alpha "exec oi"
    }
    finally {
        Remove-Item Env:JEV_PROJECT_ID
        Rename-Item (Join-Path $bin "project.ps1.off") "project.ps1"
    }
    Check "sem project.ps1: claude com os args originais" (($f1.Args -join "|") -ceq ($userExpected -join "|"))
    Check "sem project.ps1: exit code preservado" ($f1.Exit -eq 5)
    Check "sem project.ps1: codex com os args originais" (($f2.Args -join "|") -ceq "exec|oi")
    Check "sem project.ps1: variaveis herdadas removidas" ($f2.Env["JEV_PROJECT_ID"] -eq "<unset>")

    # --- wrapper gerado ---
    $text = Get-Content (Join-Path $bin "claude.cmd") -Raw
    Check "wrapper sem token" (-not ($text -match '(?i)router-token|ROUTER_TOKEN|AUTH_TOKEN|API_KEY|authorization|x-api-key|bearer'))
    Check "wrapper sem delayed expansion" (-not ($text -match '(?i)enabledelayedexpansion'))
    Check "wrapper preserva exit code" ($text.Contains('endlocal & exit /b %JEV_EXIT_CODE%'))
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Remove-Item Env:FAKE_OUT, Env:FAKE_EXIT -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:count - $script:fail)/$($script:count) testes passaram."

if ($script:fail -gt 0) {
    exit 1
}
