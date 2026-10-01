# Jev Smart Router

Roteamento inteligente para **Claude Code** e **OpenAI Codex**, usando o [Jev Router](https://github.com/dirien/jev-router) para escolher automaticamente o tier adequado para cada tarefa.

O projeto também monitora novos modelos e executa um mini-benchmark antes de recomendar uma possível substituição.

## Arquitetura

```text
                         ┌───────────────────────┐
Claude Code ────────────►│                       │
                         │      Jev Router       │
OpenAI Codex ───────────►│                       │
                         └───────────┬───────────┘
                                     │
                                     ▼
                              Jev classifica
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
               fast              balanced            frontier
```

O mapeamento padrão é:

```text
mechanical → fast
routine    → balanced
complex    → frontier
deep       → frontier
```

O usuário continua usando normalmente:

```powershell
claude
```

ou:

```powershell
codex
```

Os wrappers instalados pelo projeto verificam silenciosamente se existe algum modelo novo aguardando benchmark antes de iniciar o CLI real.

---

## Recursos

- Claude Code através do Jev Router
- OpenAI Codex através do Jev Router
- reutiliza login oficial do Claude Code
- reutiliza login oficial ChatGPT/Codex
- seleção automática de tier pelo Jev
- Docker Compose
- model watcher automático
- busca por novos modelos a cada 24 horas
- mini-benchmark somente quando aparece candidato novo
- cache de benchmarks
- nenhum modelo é substituído automaticamente
- relatórios locais de benchmark
- wrappers transparentes para `codex` e `claude`

---

## Requisitos

Windows com:

- Docker Desktop
- PowerShell 5.1 ou superior
- Claude Code instalado e autenticado
- OpenAI Codex instalado e autenticado
- Git
- uma `TYPESAFE_API_KEY`

Antes da instalação, estes comandos devem funcionar:

```powershell
docker version
codex --version
claude --version
codex login status
```

---

## Instalação

Clone o projeto:

```powershell
git clone SEU_REPOSITORIO_AQUI
cd jev-router
```

Execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

O instalador:

1. verifica Docker
2. cria `config\config.json`, se necessário
3. cria `config\env`, se necessário
4. gera um `JEV_ROUTER_TOKEN`
5. solicita a `TYPESAFE_API_KEY` se ela ainda não existir
6. descobre os executáveis reais do Codex e Claude
7. gera os wrappers
8. adiciona `bin` ao PATH do usuário
9. constrói os containers
10. inicia o Jev Router
11. inicia o model watcher
12. verifica `/healthz`

---

# Configuração dos clientes

A instalação do Docker não modifica automaticamente os arquivos pessoais do Claude Code ou Codex.

Isso é proposital para preservar hooks, plugins e configurações existentes.

## Claude Code

No arquivo:

```text
%USERPROFILE%\.claude\settings.json
```

adicione ao objeto de nível superior:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "ANTHROPIC_CUSTOM_HEADERS": "x-jev-router-token: SEU_JEV_ROUTER_TOKEN",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  }
}
```

O token pode ser encontrado localmente em:

```text
config\env
```

na linha:

```text
JEV_ROUTER_TOKEN=...
```

Não publique esse valor.

Depois feche todas as sessões abertas do Claude Code e abra novamente.

---

## OpenAI Codex

No arquivo:

```text
%USERPROFILE%\.codex\config.toml
```

configure:

```toml
model = "jev-auto"
model_provider = "jev"

[model_providers.jev]
name = "Jev Router"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
http_headers = { "x-jev-router-token" = "SEU_JEV_ROUTER_TOKEN" }
```

Preserve suas outras opções, plugins, projetos e configurações existentes.

Confira:

```powershell
codex login status
```

O esperado é:

```text
Logged in using ChatGPT
```

---

# Verificação

Execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\status.ps1
```

Também é possível testar:

```powershell
codex --version
claude --version
```

Health endpoint:

```text
http://127.0.0.1:4000/healthz
```

Live View:

```text
http://127.0.0.1:4100
```

---

# Descoberta automática de modelos

O mecanismo principal de descoberta automática é o container:

```text
jev-model-watcher
```

Ele é iniciado junto com o Jev Router pelo `docker compose` e executa uma verificação:

- imediatamente ao subir
- novamente a cada 24 horas
- sem depender do Agendador de Tarefas do Windows
- sem consumir tokens de Claude ou Codex durante a simples detecção

O watcher utilizado normalmente pelo projeto é:

```text
model-lab\docker-watcher.mjs
```

Ele consulta as fontes configuradas, compara os modelos encontrados com o estado conhecido e registra novos candidatos em:

```text
model-lab\pending-models.json
```

O arquivo:

```text
model-lab\watch.ps1
```

também está incluído no repositório, mas funciona apenas como **ferramenta manual/fallback**.

Ele pode ser usado para executar a mesma verificação diretamente no Windows em situações de diagnóstico ou quando o usuário não quiser utilizar o container `jev-model-watcher`.

No funcionamento padrão do projeto, **não é necessário executar `watch.ps1` manualmente**.

Estado dos modelos já conhecidos:

```text
model-lab\seen-models.json
```

Novos candidatos:

```text
model-lab\pending-models.json
```

Esses arquivos são locais e não são versionados.

Um modelo descoberto remotamente **não é confiável automaticamente**. O watcher (e também `watch.ps1` e `benchmark.ps1`, de forma independente) só aceita nomes que:

- sejam texto com no máximo 128 caracteres
- comecem com letra ou número e usem apenas `A-Z a-z 0-9 . _ : -`
- comecem com `gpt-` (OpenAI) ou `claude-` (Anthropic)

Providers desconhecidos e nomes fora desse formato são descartados e registrados no log sem ecoar o valor recebido.

---

# Benchmark

Quando um modelo novo é detectado, ele recebe o estado:

```text
pending-benchmark
```

Na próxima execução de:

```powershell
codex
```

ou:

```powershell
claude
```

o wrapper detecta a pendência e executa:

```text
model-lab\benchmark.ps1
```

O benchmark compara:

```text
modelo atual
versus
modelo candidato
```

usando inicialmente poucos casos para reduzir consumo de tokens.

Resultados possíveis incluem:

```text
MANTER-ATUAL
MANTER-ATUAL-CANDIDATO-FALHOU
EMPATE-ETAPA-1
CANDIDATO-ETAPA-2
INCONCLUSIVO
```

Nenhum resultado altera automaticamente o `config.json`: nenhum candidato muda os tiers sozinho. A promoção de um modelo é sempre uma edição manual.

O benchmark só executa chamadas de modelo quando existe alguma pendência em `pending-models.json`; sem pendências, nenhuma chamada é feita.

---

# Cache

Resultados já calculados são armazenados em:

```text
model-lab\benchmark-cache.json
```

Assim o modelo atual não precisa ser reavaliado toda vez que surge um novo candidato.

---

# Relatórios

Relatórios ficam em:

```text
model-lab\reports\
```

Exemplo:

```text
20261001-150000-openai-fast-modelo-novo.json
```

---

# Logs

Router:

```powershell
docker logs jev-router --tail 100
```

Watcher:

```powershell
docker logs jev-model-watcher --tail 100
```

Log local do watcher:

```text
model-lab\docker-watcher.log
```

Benchmark:

```text
model-lab\benchmark.log
```

---

# Segurança

Nunca versione:

```text
config\env
config\config.json
bin\codex.cmd
bin\claude.cmd
runtime\
model-lab\seen-models.json
model-lab\pending-models.json
model-lab\benchmark-cache.json
model-lab\reports\
```

O `.gitignore` fornecido pelo projeto cobre esses arquivos e o `.dockerignore` os mantém fora do contexto de build do Docker.

Os wrappers `bin\codex.cmd` e `bin\claude.cmd` são gerados localmente pelo `install.ps1`, pois contêm caminhos específicos da máquina. Eles não são versionados.

O `install.ps1` restringe as permissões de `config\env` ao usuário atual, SYSTEM e Administradores (sem alterar o conteúdo). Se isso falhar, ele apenas emite um aviso.

Isolamento dos containers:

- o router recebe somente `config\config.json` e `config\env`, ambos em modo somente leitura, além do volume de estado
- o watcher recebe somente `config\config.json` (somente leitura) e a pasta `model-lab\`; ele **não** tem acesso a `config\env` nem a outras credenciais
- o watcher roda com sistema de arquivos somente leitura (exceto `model-lab\`), sem capabilities e com `no-new-privileges`
- as portas ficam publicadas apenas em `127.0.0.1`

Como `config\config.json` e `config\env` são montados como arquivos individuais, ambos precisam existir antes do `docker compose up` (o `install.ps1` os cria).

Essas medidas reduzem a exposição, mas não eliminam todos os riscos; por exemplo, qualquer processo executado com o seu usuário do Windows ainda consegue ler `config\env`.

O projeto não precisa armazenar:

- senha do ChatGPT
- senha da Anthropic
- token de login do Codex
- token de login do Claude

Os logins continuam sendo administrados pelos CLIs oficiais.

---

# Estrutura

```text
jev-router/
│
├── bin/
│   ├── codex.cmd        (gerado pelo install.ps1, não versionado)
│   ├── claude.cmd       (gerado pelo install.ps1, não versionado)
│   └── preflight.ps1
│
├── config/
│   ├── config.example.json
│   └── env.example
│
├── model-lab/
│   ├── benchmark.ps1
│   ├── cases.json
│   ├── claude-direct-settings.json
│   ├── docker-watcher.mjs
│   ├── watch.ps1
│   └── reports/
│
├── runtime/
│   └── .gitkeep
│
├── scripts/
│   ├── install.ps1
│   ├── status.ps1
│   └── uninstall.ps1
│
├── Dockerfile
├── compose.yaml
├── .dockerignore
├── .gitignore
└── README.md
```

---

# Desinstalação

Execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

Isso:

- remove `bin` do PATH
- para os containers
- preserva configurações e segredos locais

Para também remover o runtime:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -RemoveRuntime
```

Para remover apenas os wrappers, mantendo os containers:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -KeepContainers
```

---

# Atualização

Atualize o repositório:

```powershell
git pull
```

Depois rode novamente:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Configurações locais existentes são preservadas.

---

# Troubleshooting

## `codex` ou `claude` não usa o wrapper

Confira:

```powershell
Get-Command codex -All
Get-Command claude -All
```

O primeiro resultado deve apontar para:

```text
...\jev-router\bin\codex.cmd
```

e:

```text
...\jev-router\bin\claude.cmd
```

Se o PATH do terminal ainda estiver desatualizado, recarregue-o:

```powershell
$machinePath = [Environment]::GetEnvironmentVariable(
    "Path",
    "Machine"
)

$userPath = [Environment]::GetEnvironmentVariable(
    "Path",
    "User"
)

$env:Path = "$userPath;$machinePath"
```

Depois confira novamente:

```powershell
Get-Command codex -All
Get-Command claude -All
```

## Router não responde

```powershell
docker logs jev-router --tail 100
```

## Watcher não responde

```powershell
docker logs jev-model-watcher --tail 100
```

## Verificar tudo

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\status.ps1