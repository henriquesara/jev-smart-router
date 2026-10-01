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

Para ver o que seria executado (combinações, argumentos e o que já está em cache) sem chamar nenhum modelo e sem alterar cache, pendências ou relatórios:

```powershell
powershell -ExecutionPolicy Bypass -File .\model-lab\benchmark.ps1 -DryRun
```

---

# Reasoning effort

Três conceitos diferentes:

| Conceito | O que é | Onde é definido |
| --- | --- | --- |
| tier | nível de roteamento (`fast`, `balanced`, `frontier`) | `config\config.json` (router) |
| modelo | modelo concreto atendendo o tier | `config\config.json` (router) |
| effort | quanto raciocínio o modelo usa por requisição | cliente (Codex/Claude Code); no benchmark, `model-lab\efforts.json` |

No benchmark e nos relatórios, quatro informações aparecem separadas:

| Termo | Significado | Origem |
| --- | --- | --- |
| modelo atual do tier (`routerTierModel`) | modelo que o router usa hoje no tier | `pending-models.json` (registrado pelo watcher) |
| effort baseline (`efforts.baseline`) | effort com que o modelo atual é medido na comparação | effort do cliente, quando declarado e `baselineFromClient: true`; senão `baseline` em `efforts.json` |
| effort do cliente (`efforts.client`) | effort que o Codex/Claude usa no dia a dia | `model-lab\client-efforts.json` (local); `unknown` quando não declarado |
| effort recomendado (`efforts.recommended`) | effort da melhor combinação do candidato | resultado do benchmark; **sugestão, nunca aplicado** (`applied: false`) |

O baseline só é igual ao effort do cliente quando o effort do cliente é conhecido. `efforts.baselineMatchesClient` mostra `true`/`false` nesse caso e `null` quando o effort do cliente é desconhecido.

O effort é **específico de cada provider**. Os valores não são equivalentes entre OpenAI e Anthropic e nunca são comparados entre si:

| Provider | Mecanismo usado no benchmark | Valores aceitos |
| --- | --- | --- |
| OpenAI (Codex) | `-c model_reasoning_effort="<effort>"` | `low`, `medium`, `high`, `xhigh` |
| Anthropic (Claude Code) | `--effort <effort>` | `low`, `medium`, `high`, `xhigh`, `max` |

Essas listas são allowlists fixas em `benchmark.ps1`. `efforts.json` só escolhe valores dentro delas; qualquer outro valor (inclusive maiúsculas, aspas ou texto extra) é descartado com aviso, sem ser ecoado no log, e nunca vira argumento de linha de comando.

Modelos sem suporte a effort (por exemplo `claude-haiku-*`, listados em `modelsWithoutEffort`) rodam sem nenhuma flag e aparecem no relatório como `not-applicable`. Quando o provider suporta effort mas nenhum valor é enviado, o relatório mostra `cli-default` (o CLI decide; o valor real não é conhecido pelo benchmark).

## efforts.json

```json
{
  "version": 1,
  "providers": {
    "openai": {
      "supportsEffort": true,
      "baselineFromClient": true,
      "baseline": { "fast": "low", "balanced": "low", "frontier": "low" },
      "matrix": {
        "fast": ["low"],
        "balanced": ["low", "medium"],
        "frontier": ["medium", "high"]
      }
    },
    "anthropic": {
      "supportsEffort": true,
      "baselineFromClient": true,
      "modelsWithoutEffort": ["claude-haiku-"],
      "baseline": { "fast": null, "balanced": null, "frontier": null },
      "matrix": { "fast": [], "balanced": ["low", "medium"], "frontier": ["medium", "high"] }
    }
  }
}
```

- `baseline`: effort fixo para medir o modelo atual do tier quando o effort do cliente não é conhecido. `null` = nenhum effort enviado (`cli-default`). Não representa o effort do seu cliente. A chave antiga `current` ainda é aceita com o mesmo significado.
- `baselineFromClient`: com `true` e effort do cliente declarado, o modelo atual é medido com o effort do cliente em vez de `baseline`.
- `matrix`: efforts testados para o **candidato** em cada tier (no máximo 3 por tier). Lista vazia = o candidato roda com o mesmo effort do baseline.
- `supportsEffort: false` desliga completamente o envio de effort para o provider.
- Sem `efforts.json`, o benchmark mantém o comportamento anterior: baseline OpenAI `low`, Claude sem `--effort`.

## client-efforts.json

Arquivo **local e opcional** (ignorado pelo Git) que declara o effort que cada cliente usa no dia a dia. Como o valor depende de cada máquina, ele não fica no repositório:

```powershell
Copy-Item .\model-lab\client-efforts.example.json .\model-lab\client-efforts.json
```

```json
{
  "version": 1,
  "providers": {
    "openai": { "effort": "medium" },
    "anthropic": { "effort": null }
  }
}
```

- Use o mesmo valor configurado no cliente (por exemplo `model_reasoning_effort` do Codex). `null` = desconhecido.
- O benchmark **não** lê nem altera `%USERPROFILE%\.codex\config.toml` ou as configurações do Claude Code: esses arquivos podem conter tokens, por isso o effort do cliente é sempre declarado explicitamente.
- Valores fora da allowlist do provider são descartados com aviso (sem ecoar o valor) e tratados como desconhecidos.
- Sem o arquivo, o effort do cliente aparece como `unknown` e o baseline vem de `efforts.json`.

Custo por candidato na etapa 1: `casos × (1 + efforts da matriz)`, descontando o que já estiver em cache. Com 3 casos e `["low", "medium"]`, são até 9 chamadas.

## Como o benchmark compara

O modelo atual do tier, medido com o effort baseline, é comparado com **cada** combinação `candidato + effort` da matriz. Cada combinação recebe um status em relação ao baseline (`versusBaseline`, as mesmas regras da etapa 1) e a melhor combinação é escolhida por:

1. mais casos corretos
2. menos falhas de execução
3. **menor effort** (em empate de qualidade, o effort menor vence)
4. menor latência média

Exemplos: `low 3/3` e `medium 3/3` → `low`. `low 2/3` e `medium 3/3` → `medium` pode avançar.

Somente a melhor combinação, e apenas quando o status dela é `CANDIDATO-ETAPA-2`, é listada em `stage2.candidates` no relatório. A etapa 2 ainda não está implementada; o relatório apenas prepara essa lista.

Tokens de saída são registrados quando o próprio Claude Code os informa (`outputTokens`); no Codex esse dado não fica disponível de forma confiável e fica `null`. Tokens e custo não entram na decisão.

Nada é aplicado automaticamente: nem tiers, nem modelos, nem effort. O watcher continua apenas registrando modelos novos em `pending-models.json`; os efforts testados vêm de `efforts.json` no momento do benchmark.

## Limitação do router

O Jev Router (1.6.0) só substitui o campo `model` da requisição e pode remover campos (`omit`, por exemplo `output_config.effort` nos targets Haiku). Ele **não** define nem reescreve reasoning effort por tier, e uma chave `effort` em `config.json` seria ignorada silenciosamente, por isso ela não é usada.

Na prática, o effort enviado é o que o cliente envia:

- Codex: `model_reasoning_effort` no seu `%USERPROFILE%\.codex\config.toml` (ou `/model` na sessão)
- Claude Code: `--effort` ou a configuração de effort do próprio Claude Code

Esse mesmo effort vale para qualquer tier que o router escolher. O effort recomendado pelo benchmark é apenas uma sugestão: ele não é aplicado em lugar nenhum, e usá-lo exige uma alteração manual no cliente.

---

# Cache

Resultados já calculados são armazenados em:

```text
model-lab\benchmark-cache.json
```

Assim o modelo atual não precisa ser reavaliado toda vez que surge um novo candidato.

A chave inclui o effort:

```text
provider|tier|modelo|effort|caseId
```

`effort` é `none` quando nenhum effort é enviado. Resultados de `low`, `medium` e `high` nunca se misturam. Entradas antigas (`provider|tier|modelo|caseId`) são convertidas na leitura: OpenAI para `low` (o valor que o benchmark antigo sempre usava) e Anthropic para `none`.

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

Cada relatório contém:

- `routerTierModel`: modelo atual do tier no router;
- `efforts.baseline`: effort usado para medir o modelo atual e sua origem (`client-efforts.json`, `efforts.json` ou `legacy-default`);
- `efforts.client`: effort do cliente no dia a dia e sua origem (`unknown` quando não declarado);
- `efforts.baselineMatchesClient`: `true`/`false`, ou `null` se o effort do cliente é desconhecido;
- `efforts.recommended`: modelo e effort da melhor combinação, sempre com `applied: false`;
- `baseline`: resumo do modelo atual com o effort baseline;
- `candidates`: um resumo por effort testado, com `passed`, `failures`, `averageMilliseconds` e `versusBaseline`;
- `candidate` (a melhor combinação), `recommendation`, `stage2` e `results` (`baseline` e `candidate`).

Cada resultado registra provider, tier, modelo, effort, caso, acerto, latência e erro.

---

# Testes

Testes do model-lab (reasoning effort, allowlists, cache, argumentos das CLIs, `-DryRun`, relatórios). Não fazem nenhuma chamada real de modelo: usam uma cópia temporária do `model-lab` e CLIs falsos (`.cmd`) que só registram os argumentos recebidos.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\model-lab-effort.tests.ps1
```

O script mostra o total de casos e falhas de cada parte (unidades e integração) e termina com código `1` se algum teste falhar. Os arquivos temporários ficam em `%TEMP%\jev-effort-test-<guid>` e são removidos ao final. Não precisa de `runtime\runtime-paths.json`, credenciais nem rede.

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
│   ├── client-efforts.example.json
│   ├── client-efforts.json   (local, não versionado)
│   ├── docker-watcher.mjs
│   ├── efforts.json
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
├── tests/
│   └── model-lab-effort.tests.ps1
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