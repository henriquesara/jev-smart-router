param(
    [ValidateSet("codex", "claude")]
    [string]$Cli = "codex"
)

# Identifica o projeto da pasta atual para o Live View do router. Chamado
# pelos wrappers bin\codex.cmd e bin\claude.cmd (gerados por install.ps1).
#
# Escreve uma unica linha:  <nome> <id do projeto> <id da instancia> [settings]
#   - nome: basename da raiz do projeto, sanitizado ([A-Za-z0-9._-], ate 40);
#   - id do projeto: 12 hex do SHA-256 da raiz normalizada;
#   - id da instancia: 10 caracteres [a-z0-9] aleatorios, novos a cada processo;
#   - settings: so para o claude, quando o usuario ja passou --settings
#     (o wrapper entao nao injeta nada).
# A raiz e `git rev-parse --show-toplevel` ou, fora de um repositorio, a pasta
# atual. Nenhum caminho e escrito. Em qualquer falha nao escreve nada, e o CLI
# segue sem projeto. Nao le token nem configuracao do Claude/Codex.

$ErrorActionPreference = "Stop"

function Get-ProjectRoot([string]$Cwd) {

    $top = $null

    try {
        $top = & git -C $Cwd rev-parse --show-toplevel 2>$null

        if ($LASTEXITCODE -ne 0) {
            $top = $null
        }
    }
    catch {
        $top = $null
    }

    if ([string]::IsNullOrWhiteSpace($top)) {
        return $Cwd
    }

    return ([string]$top).Trim()
}

# Absoluto, separador /, sem barra final, minusculo no Windows.
function Get-NormalizedRoot([string]$Root) {

    $full = [System.IO.Path]::GetFullPath($Root).Replace('\', '/').TrimEnd('/')

    if ([System.IO.Path]::DirectorySeparatorChar -eq '\') {
        $full = $full.ToLowerInvariant()
    }

    return $full
}

function Get-ProjectName([string]$Root) {

    $base = [System.IO.Path]::GetFileName($Root.Replace('\', '/').TrimEnd('/').Replace('/', '\'))

    $name = $base -replace '[^A-Za-z0-9._-]', '-'
    $name = $name -replace '\.{2,}', '.'

    if ($name.Length -gt 40) {
        $name = $name.Substring(0, 40)
    }

    if ($name -notmatch '^[A-Za-z0-9._-]{1,40}$' -or $name -match '^\.+$' -or $name.Contains('..')) {
        return "project"
    }

    return $name
}

function Get-ProjectId([string]$NormalizedRoot) {

    $sha = [System.Security.Cryptography.SHA256]::Create()

    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($NormalizedRoot))
    }
    finally {
        $sha.Dispose()
    }

    return (-join ($hash[0..5] | ForEach-Object { $_.ToString("x2") }))
}

# Amostragem por rejeicao: sem vies de modulo.
function New-InstanceId([int]$Length = 10) {

    $alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $chars = New-Object System.Text.StringBuilder
    $byte = New-Object byte[] 1

    try {
        while ($chars.Length -lt $Length) {
            $rng.GetBytes($byte)

            if ($byte[0] -lt 252) {
                [void]$chars.Append($alphabet[$byte[0] % 36])
            }
        }
    }
    finally {
        $rng.Dispose()
    }

    return $chars.ToString()
}

# Separa a linha de comando em argumentos pelas regras do Windows (CRT):
# espaco/tab separam fora de aspas; 2n barras + aspa = n barras e alterna
# aspas; 2n+1 barras + aspa = aspa literal; "" dentro de aspas = aspa literal.
# Quoted indica que o argumento comecou com aspa.
function Split-CliArgs([string]$Line) {

    $result = New-Object System.Collections.Generic.List[object]

    if ([string]::IsNullOrEmpty($Line)) {
        return $result
    }

    $i = 0
    $n = $Line.Length

    while ($i -lt $n) {
        while ($i -lt $n -and ($Line[$i] -eq ' ' -or $Line[$i] -eq "`t")) {
            $i++
        }

        if ($i -ge $n) {
            break
        }

        $text = New-Object System.Text.StringBuilder
        $quoted = $Line[$i] -eq '"'
        $inQuotes = $false

        while ($i -lt $n) {
            $c = $Line[$i]

            if ($c -eq '\') {
                $slashes = 0

                while ($i -lt $n -and $Line[$i] -eq '\') {
                    $slashes++
                    $i++
                }

                if ($i -lt $n -and $Line[$i] -eq '"') {
                    [void]$text.Append([char]'\', [int][Math]::Floor($slashes / 2))

                    if ($slashes % 2 -eq 1) {
                        [void]$text.Append('"')
                        $i++
                    }
                }
                else {
                    [void]$text.Append([char]'\', $slashes)
                }

                continue
            }

            if ($c -eq '"') {
                if ($inQuotes -and $i + 1 -lt $n -and $Line[$i + 1] -eq '"') {
                    [void]$text.Append('"')
                    $i += 2
                    continue
                }

                $inQuotes = -not $inQuotes
                $i++
                continue
            }

            if (-not $inQuotes -and ($c -eq ' ' -or $c -eq "`t")) {
                break
            }

            [void]$text.Append($c)
            $i++
        }

        $result.Add([pscustomobject]@{ Text = $text.ToString(); Quoted = $quoted })
    }

    return $result
}

# Os argumentos do claude chegam por JEV_CLI_ARGS (definida pelo wrapper).
# Conta so um argumento inteiro igual a --settings ou que comece com
# --settings=. Nao conta texto dentro de outro argumento, nem o argumento
# entre aspas logo apos -p/--print (o prompt), mesmo que seja "--settings".
function Test-UserSettings([string]$Arguments) {

    $tokens = @(Split-CliArgs $Arguments)

    for ($k = 0; $k -lt $tokens.Count; $k++) {
        $t = $tokens[$k].Text

        if ($t -cne '--settings' -and -not $t.StartsWith('--settings=', [System.StringComparison]::Ordinal)) {
            continue
        }

        if ($k -gt 0 -and $tokens[$k].Quoted -and ($tokens[$k - 1].Text -ceq '-p' -or $tokens[$k - 1].Text -ceq '--print')) {
            continue
        }

        return $true
    }

    return $false
}

if ($MyInvocation.InvocationName -eq '.') {
    return
}

try {
    $root = Get-ProjectRoot (Get-Location -PSProvider FileSystem).ProviderPath
    $name = Get-ProjectName $root
    $id = Get-ProjectId (Get-NormalizedRoot $root)
    $instance = New-InstanceId

    $line = "$name $id $instance"

    if ($Cli -eq "claude" -and (Test-UserSettings $env:JEV_CLI_ARGS)) {
        $line += " settings"
    }

    [Console]::Out.WriteLine($line)
}
catch {
    exit 0
}

exit 0
