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
         ┌──────────────────┬────────┴─────────┬──────────────────┐
         ▼                  ▼                  ▼                  ▼
       fast             balanced           frontier             deep
         │                  │                  │                  │
         ▼                  ▼                  ▼                  ▼
  modelo + effort    modelo + effort    modelo + effort    modelo + effort
                                     │
                                     ▼
                           requisição ao upstream
```

O mapeamento padrão (`config.example.json`) é:

```text
mechanical → fast     → modelo do tier + effort low   (Haiku: sem effort)
routine    → balanced → modelo do tier + effort medium
complex    → frontier → modelo do tier + effort high
deep       → deep     → modelo do tier + effort xhigh
```

O tier `deep` é opcional; veja [Tier `deep`](#tier-deep) antes de adotá-lo no seu `config.json`.

O router define **o modelo e o reasoning effort** de cada requisição a partir do tier escolhido. Os valores vêm do `config.json` (veja [Effort por tier no router](#effort-por-tier-no-router)).

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
- modelo **e** reasoning effort definidos pelo router por tier (patch versionado sobre o Jev Router 1.6.0)
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

O `env` do `settings.json` **tem precedência** sobre as variáveis do processo. Por isso `ANTHROPIC_BASE_URL=... claude` não troca o router; para testar contra outro router sem alterar o arquivo, passe um settings temporário, que tem precedência maior:

```powershell
claude -p "Reply with just: ok" --settings .\settings-teste.json
```

com `{"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:4010", "ANTHROPIC_CUSTOM_HEADERS": "x-jev-router-token: ...\nx-jev-tier: balanced"}}`. Ao rodar dentro de outra sessão do Claude Code, remova antes `CLAUDECODE` e `CLAUDE_CODE_CHILD_SESSION` do ambiente.

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

Chaves de nível superior (`model`, `model_provider`, `notify`, ...) precisam vir **antes** de `[model_providers.jev]`: no TOML, tudo o que vem depois de um cabeçalho de tabela pertence a ela. Um `notify = [...]` escrito abaixo de `[model_providers.jev]` vira um campo do provider e o Codex avisa que ele é ignorado.

### Descoberta de modelos (`GET /v1/models`)

O Codex 0.159 consulta `GET {base_url}/models?client_version=...` ao iniciar e grava o campo `models` da resposta **como veio** em `%USERPROFILE%\.codex\models_cache.json`. Esse campo é uma lista de descrições completas de modelo (`slug`, níveis de reasoning, janela de contexto, ferramentas, ...). Uma lista vazia ou incompleta substituiria o cache, então o router nunca monta um catálogo próprio:

- O router repassa o catálogo do upstream do surface `openai` (o backend do ChatGPT, `.../backend-api/codex/models`), usando o login do próprio cliente, como no `/v1/responses`. Só o target do tier padrão (ou o `trusted`) com `trusted: true`, `clientAuth: true` e sem `keyEnv` é usado: nenhuma chave do router é gasta e o login nunca vai para um upstream não confiável.
- A resposta só é repassada se for `200`, JSON, com `models` não vazio e cada modelo com `slug` (no máximo 4 MB). Ela segue byte a byte, com apenas `ETag`/`X-Models-Etag` como headers do upstream.
- Qualquer outra resposta (erro, catálogo vazio, formato diferente, upstream fora do ar) vira `404`. O Codex trata `404` como "sem catálogo aqui" e **mantém o cache como estava**.
- O token do router é exigido como nas demais rotas (`401` sem ele) e não é repassado ao upstream.
- Pedidos com `anthropic-version` (Claude Code) continuam recebendo `404`, como antes.
- O log registra só `{event: "models", upstream, status, relayed}`, sem headers nem conteúdo.
- Limitação: `jev-auto` não está no catálogo oficial, então o Codex mostra `Model metadata for jev-auto not found. Defaulting to fallback metadata`. É esperado; o modelo real é escolhido pelo router.

Antes do patch, o Codex registrava `failed to refresh available models: unexpected status 404` a cada execução. Para ativar: `docker compose up -d --build jev-router`.

### Fallback de modelo pelo catálogo da conta (`fallbacks`)

O backend do ChatGPT só aceita, para cada conta (e versão do Codex), os modelos do catálogo que ele entrega naquele momento. Um modelo fora dele falha **toda** requisição com `400 {"detail":"The '<modelo>' model is not supported when using Codex with a ChatGPT account."}`. Modelos podem sair e voltar do catálogo; o router se adapta sozinho, sem trocar a config:

- **Preferred model**: o `model` do target do tier (`surfaces.openai.<tier>.model`). É o modelo ideal do tier e nunca é reescrito.
- **Actual model**: o modelo realmente enviado ao upstream, depois de conferir se o catálogo da conta o tem. Aparece em `x-jev-model`, no campo `model` do log e no Live View.
- **Catalog fallback**: se o preferred não está no catálogo, o router usa o primeiro de `fallbacks` que esteja, **com o mesmo tier e o mesmo effort**. Quando o preferred volta ao catálogo, a próxima requisição já volta a usá-lo.

```json
"balanced": {
  "url": "https://chatgpt.com/backend-api/codex",
  "model": "gpt-6.1-sol",
  "effort": "medium",
  "fallbacks": ["gpt-6-sol", "gpt-5.6-terra", "gpt-6-luna"],
  ...
}
```

Regras da escolha:

- Só para o surface `openai`, só em targets servidos pelo mesmo upstream do catálogo com o login do cliente (`trusted`, `clientAuth`, sem `keyEnv`). Anthropic não é afetado; `fallbacks` em um target Anthropic é erro de config.
- Um fallback precisa estar no catálogo, **não** ter `visibility: "hide"` e aceitar o effort do tier (`supported_reasoning_levels`). Um preferred escondido (`hide`) ainda é usado, porque foi configurado explicitamente.
- Nada além do modelo muda: tier, `sessionTier`, tier efetivo, soft/hard ratchet, `reason`, sessão e projeto são os mesmos de sem fallback. O fallback nunca vira `client-model`.
- Sem catálogo ainda (router recém-iniciado), a requisição espera no máximo 1,5 s pelo primeiro; sem resposta, segue com o preferred.

**Uma recuperação por requisição.** Se o upstream responder exatamente o `400` acima, nomeando o modelo enviado, o router não repassa esse erro: marca o modelo como indisponível para a conta e reenvia **a mesma requisição uma única vez** no próximo fallback válido (nada foi executado pelo upstream, então o reenvio é seguro). Não há retry para `401`, `403`, `429`, `5xx`, timeout/conexão, erro de conteúdo nem qualquer outro `400`. Se o reenvio também falhar, o cliente recebe a resposta como veio.

- **Sem catálogo no momento da recusa** (ex.: primeira requisição após o restart, com o primeiro fetch falhando), o router tenta obter o catálogo por até 1,5 s antes de escolher o modelo do retry, ignorando o backoff de 30 s e reaproveitando um refresh já em andamento. Se o catálogo chegar, o retry vai para o primeiro fallback que a conta realmente tem; se não, vai para o próximo fallback ainda não tentado, como antes. Em qualquer caso, no máximo um retry.
- **Bloqueio temporário com evidência positiva.** O modelo recusado fica bloqueado para a conta por até 15 min. Se um catálogo obtido depois da recusa voltar a listá-lo, o bloqueio cai na hora e o preferred volta a ser usado na próxima requisição. A exceção é um modelo que o catálogo já listava quando o upstream o recusou: aí o catálogo e o upstream discordam, listar de novo não é evidência nova, e o bloqueio dura os 15 min (evita uma recusa + retry a cada requisição).

**Cache.** `GET /v1/models` e o guard usam a mesma busca ao upstream e o mesmo cache em memória:

- uma entrada por conta (`chatgpt-account-id`, ou o login quando não há conta) e versão do Codex (`client_version`, ou a versão no `User-Agent` `codex_exec/x.y.z`), porque o catálogo muda com a versão;
- a chave é um HMAC com uma chave aleatória do processo: nem o account id nem o token ficam guardados ou podem ser recuperados dela;
- só ficam `slug`, `visibility` e níveis de reasoning de cada modelo; nada de instruções, headers ou credenciais, e nada vai para disco (o cache começa vazio a cada restart);
- fresco por 5 min; de 5 min a 1 h é usado enquanto **um** refresh roda em segundo plano (um por conta/versão, sem stampede); depois de 1 h é descartado; um refresh que falhou só é tentado de novo após 30 s;
- o refresh envia só `authorization`, `chatgpt-account-id`, `originator` e `user-agent` do cliente; o token do router nunca sai.
- Cada `GET /v1/models` que o próprio Codex faz ao iniciar também atualiza o cache.

**Log e Live View.** Sem fallback, o log tem só `model`. Com fallback, `route` e `done` trazem:

```json
{ "model": "gpt-5.6-terra", "preferred_model": "gpt-6.1-sol", "model_fallback": true, "model_fallback_reason": "catalog-unavailable" }
```

`model_fallback_reason` é `catalog-unavailable` (fora do catálogo) ou `upstream-unsupported` (o upstream recusou; nesse caso o `done` traz também `refused_model`). A resposta ganha o header `x-jev-preferred-model`. Os refreshes do guard aparecem como `{event: "catalog", upstream, status, models}` (só a contagem). No Live View, o destaque da rota e a linha do feed mostram discretamente `gpt-5.6-terra fallback from gpt-6.1-sol`; o tier exibido continua o do tier. No grafo, a aresta configurada `tier → modelo preferred` continua lá, e a rota física real aparece como uma aresta tracejada e mais fraca `tier → modelo do fallback`; o destaque da requisição em foco segue essa aresta. Não é uma nova decisão de tier: é só o modelo físico. Quando houve retry, a requisição (contagem e effort no tooltip do modelo) passa a contar para o modelo que realmente respondeu, não para o recusado.

#### Política de fallback por tier

A ordem de `fallbacks` é **política de configuração**, não uma inferência de capacidade. O catálogo do ChatGPT não informa capacidade relativa: em out/2026 ele trazia, para todos os modelos, `upgrade: null`, `model_specialty: null`, a mesma janela de contexto (272k, até 872k) e níveis de reasoning que se sobrepõem (`gpt-5.6-terra` vai até `ultra`; `gpt-6-luna` e `gpt-5.6-luna` até `max`). `priority` é só a ordem do seletor do Codex. As `description` ("balanced", "fast", "easier tasks") são texto de marketing e não servem para ordenar sozinhas.

Por isso a regra usa só o que **a própria config** afirma sobre cada modelo (qual tier o tem como preferred):

1. Desce no máximo o necessário: modelos que a config atribui a tiers aparecem em ordem decrescente de tier, e nunca um modelo de tier acima.
2. O modelo que a config atribui ao tier mais baixo (`gpt-6-luna`, o modelo do `fast`, também o mais barato em `prices`) é o último recurso de qualquer tier acima dele: vem depois de todo modelo que a config não classifica.
3. Entre modelos que a config não classifica (`gpt-6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), vale a ordem escrita pelo operador. Nenhum ranking de capacidade é inventado entre eles.

Ordem resultante no `config.example.json`:

| Tier | preferred | fallbacks |
|---|---|---|
| fast | `gpt-6-luna` | `gpt-5.6-luna` |
| balanced / trusted | `gpt-6.1-sol` | `gpt-6-sol`, `gpt-5.6-terra`, `gpt-6-luna` |
| frontier | `gpt-6-astra` | `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-terra`, `gpt-6-luna` |
| deep | `gpt-6-astra` | `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-terra`, `gpt-6-luna` |

Em frontier/deep, `gpt-5.6-terra` fica antes de `gpt-6-luna` pela regra 2 (o luna é o modelo que a config usa para `fast`), não por se afirmar que o terra é mais capaz. Com o catálogo atual (sem `gpt-6.1-sol`, `gpt-6-sol` e `gpt-6-astra`), balanced, frontier e deep rodam em `gpt-5.6-terra`. Quem preferir outra ordem só precisa mudar a lista; o teste `policy:` em `tests/router-catalog.test.mjs` confere as regras 1 e 2 no exemplo.

**Diferente do model watcher.** O `jev-model-watcher` observa amostras públicas de referência (o config de exemplo do Dirien) para sugerir modelos novos e benchmarks; ele não sabe o que a **sua** conta pode usar e nunca reescreve a config. O fallback de catálogo protege a disponibilidade real da conta Codex em cada requisição, a partir do catálogo que o ChatGPT entrega para o seu login. São funções separadas.

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

O Live View mostra o **effort** de cada requisição junto do modelo (no destaque da rota ativa, nas linhas do feed, nas lanes de sessão e no card do modelo no grafo). O valor vem só do campo `effort` dos eventos `route`/`done` do router e nunca é deduzido do tier. Eventos sem `effort` (tier sem effort configurado, ou logs antigos) mostram `effort: —`. No grafo, o card do modelo da requisição em foco mostra o effort exato dela (`tier → modelo → effort`). Os outros modelos listam os efforts com que rodaram (`effort: high/xhigh`, ou `effort: N levels` acima de dois). A contagem e o custo por effort aparecem no tooltip do modelo.

A linha roxa tracejada da rota em foco segue os cards ativos: cliente → `jev-router` → categoria do Jev → tier → modelo. Ela é desenhada sobre as próprias arestas do grafo (mesmos ids, mesmo `d`, mesmas âncoras de entrada e saída de cada card), na camada abaixo dos cards, então nunca cobre texto. Um tool step (`sticky`) passa pela categoria do prompt que definiu o tier; side calls, `count_tokens`, tags e pins (nenhuma categoria decidiu) usam a aresta que contorna a coluna do Jev. Quando o router mantém um tier diferente do da categoria (ex.: `jev-keep` no ratchet), esse trecho é desenhado entre as mesmas âncoras, já que o grafo não tem essa aresta.

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

O watcher só observa mudanças em fontes públicas de referência. Ele **não** decide se um modelo está disponível para a sua conta: isso é o [fallback de modelo pelo catálogo da conta](#fallback-de-modelo-pelo-catálogo-da-conta-fallbacks), que usa o catálogo real do Codex/ChatGPT a cada requisição. O watcher também não reescreve `config.json`.

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
| effort | quanto raciocínio o modelo usa por requisição | `effort` do target em `config\config.json` (router); sem ele, o do cliente. No benchmark, `model-lab\efforts.json` |

No benchmark e nos relatórios, quatro informações aparecem separadas:

| Termo | Significado | Origem |
| --- | --- | --- |
| modelo atual do tier (`routerTierModel`) | modelo que o router usa hoje no tier | `pending-models.json` (registrado pelo watcher) |
| effort baseline (`efforts.baseline`) | effort com que o modelo atual é medido na comparação | effort do cliente, quando declarado e `baselineFromClient: true`; senão `baseline` em `efforts.json` |
| effort do cliente (`efforts.client`) | effort que o Codex/Claude usa no dia a dia | `model-lab\client-efforts.json` (local); `unknown` quando não declarado |
| recomendação (`efforts.recommended`) | `{provider, tier, model, effort}` da melhor combinação do candidato, com `configPath`/`configPatch` prontos para o `config.json` | resultado do benchmark; **sugestão, nunca aplicada** (`applied: false`) |

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

## Effort por tier no router

O Jev Router 1.6.0 original só troca o campo `model`. Este projeto aplica no build da imagem um patch versionado (`patches\jev-router-1.6.0`) que faz o router definir também o **reasoning effort** de cada requisição, conforme o tier escolhido:

```text
Jev classifica → tier → target (modelo + effort) → requisição ao upstream
```

Basta adicionar `effort` ao target em `config\config.json`:

```json
"openai": {
  "fast":     { "model": "gpt-6-luna",  "effort": "low",    "...": "..." },
  "balanced": { "model": "gpt-6.1-sol", "effort": "medium", "...": "..." },
  "frontier": { "model": "gpt-6-astra", "effort": "high",   "...": "..." }
}
```

### Precedência

1. `effort` do target no `config.json` → **sempre vence** o effort enviado pelo cliente.
2. Target sem `effort` → o effort do cliente é preservado exatamente como veio (comportamento anterior).

O effort do cliente continua vindo de `model_reasoning_effort` no Codex ou de `--effort`/configuração do Claude Code, e só vale nos tiers sem `effort`.

### Específico por provider

O campo e os valores aceitos são diferentes em cada provider e nunca são convertidos entre si:

| Provider | Campo reescrito no body | Valores aceitos |
| --- | --- | --- |
| `openai` (Codex, `/v1/responses`) | `reasoning.effort` (demais campos de `reasoning` são preservados; um `reasoning_effort` enviado pelo cliente também é sobrescrito) | `low`, `medium`, `high`, `xhigh` |
| `anthropic` (Claude Code, `/v1/messages`) | `output_config.effort` (demais campos de `output_config` e `thinking` são preservados) | `low`, `medium`, `high`, `xhigh`, `max` |

- As allowlists são fixas e diferenciam maiúsculas (`Low` é inválido). Um valor fora delas, um valor não-string, `effort` num modelo sem suporte (`claude-haiku-*`) ou `effort` junto com um `omit` que removeria o campo **impedem o router de iniciar**, com a mensagem de erro indicando o target (o valor não é ecoado).
- Modelos Haiku não recebem effort: deixe os targets Haiku sem `effort` (eles mantêm o `omit` de `output_config.effort`).
- `count_tokens` nunca recebe effort.
- O effort aplicado aparece no header de resposta `x-jev-effort` e no campo `effort` dos logs `route` e `done` do router.

### Como o patch é aplicado

O `Dockerfile` copia `patches\jev-router-1.6.0` e executa `apply.mjs`, que:

- confere que o pacote instalado é exatamente `@ediri/jev-router@1.6.0`;
- confere o SHA-256 de `src/router.mjs`, `src/config.mjs` e `src/types.d.ts` originais;
- exige que cada trecho alterado exista exatamente uma vez;
- só grava os arquivos depois de todas as verificações, e importa os módulos alterados para validar;
- instala no Live View `ui/effort.js` (effort por requisição) e `ui/route.js` (arestas do grafo e da rota em foco, de uma só fonte).

Qualquer divergência (nova versão, upstream alterado, patch já aplicado) **falha o build** com uma mensagem clara, em vez de gerar comportamento incorreto. O mesmo patch inclui a correção existente do caminho `/backend-api/codex/responses` para o login ChatGPT.

Para ativar depois de atualizar o repositório:

```powershell
docker compose up -d --build jev-router
```

Um `config.json` sem nenhum `effort` mantém exatamente o comportamento anterior.

### Tier `deep`

O effort é definido por **tier**. Com três tiers, `complex` e `deep` caem ambos em `frontier` e recebem o mesmo effort. O `config.example.json` usa um quarto tier, `deep`, só por configuração (nenhuma mudança de código no router; é o mesmo padrão do `anthropic-fable.json` do upstream):

```json
"tiers": ["fast", "balanced", "frontier", "deep"],
"policy": { "...": "...", "escalationCeiling": "frontier" },
"jev": { "options": { "complex": { "tier": "frontier" }, "deep": { "tier": "deep" } } },
"surfaces": {
  "anthropic": { "deep": { "model": "claude-opus-5-5", "effort": "xhigh", "...": "..." } },
  "openai":    { "deep": { "model": "gpt-6-astra",     "effort": "xhigh", "...": "..." } }
}
```

Impactos, todos cobertos por testes:

- O Jev só manda para `deep` quando `deep` é a resposta mais provável. Uma resposta incerta (por exemplo `routine` 0.55 / `deep` 0.45) escala no máximo até `frontier`, por causa de `escalationCeiling`. Não existe `accept.deep`: o router não o consulta para o tier mais alto.
- `sensitiveOverride` envia conteúdo sensível para o **último** tier, que passa a ser `deep` (`xhigh`).
- No modo `ratchet`, uma sessão que chegou a `deep` fica em `deep` até o `idleResetMinutes` (o tier da sessão; com `policy.requestDowngrade`, um pedido isolado pode rodar abaixo dele, veja abaixo).
- Toda superfície precisa de um target `deep`; sem ele o router não inicia.
- `modelPins` não muda: `opus`/`fable` continuam fixando `frontier`.
- A Live View colore `deep` com a cor de `max`. `watch.ps1` e `benchmark.ps1` continuam medindo só `fast`/`balanced`/`frontier`.

Para adotar no seu `config.json` local, aplique as mesmas quatro mudanças e reinicie o router (`docker compose up -d jev-router`).

Validação real (Claude Code 2.1.286, router de teste isolado, um pedido por tier fixado com `x-jev-tier`): `fast` foi para `claude-haiku-4-5` sem effort; `balanced` para `claude-sonnet-5` com `medium`; `frontier` para `claude-opus-5-5` com `high`; `deep` para `claude-opus-5-5` com `xhigh`. Todos terminaram em `200`. Em `balanced`, os dois primeiros pedidos voltaram `400`, e isso acontece também **sem** effort no target. O Claude Code (que acredita falar com `opus`) envia recursos que `claude-sonnet-5` recusa (`output_config.effort requires a model that supports per-turn effort`, `tool_addition/tool_removal is not supported on this model`), e o próprio cliente repete o pedido sem eles.

### Downgrade por request (`policy.requestDowngrade`)

No modo `ratchet`, o router guarda o maior tier que a sessão já alcançou. Sem esta opção, todo pedido roda em `max(tier da sessão, tier do Jev)` (hard ratchet): depois de um pedido `complex`, até um pedido mecânico simples continua em `frontier`. Com ela, o ratchet vira memória histórica da sessão, e cada pedido pode descer de forma controlada:

```json
"policy": {
  "...": "...",
  "requestDowngrade": { "enabled": true, "thresholds": { "mechanical": 0.85, "routine": 0.80, "complex": 0.70 } }
}
```

- **`sessionTier`** é o maior tier que a sessão já alcançou e nunca diminui (só o `idleResetMinutes` recomeça a sessão). Tag (`#fast`, `#frontier`, …) e pin `x-jev-tier` continuam definindo o tier diretamente, inclusive para baixo: são os únicos overrides explícitos que reduzem o `sessionTier`.
- **O modelo pedido pelo cliente só sobe ou mantém o `sessionTier`, nunca o reduz.** Um modelo de família acima (ex.: `/model opus` numa sessão `balanced`) continua valendo como troca (`client-model:…`). Um modelo abaixo do `sessionTier` é ignorado como troca e o pedido segue a decisão normal (Jev, `sticky`, `fallback:keep`), como se o modelo não tivesse mudado. Motivo: depois de um turno com `request-downgrade` para Haiku, a resposta vem como `claude-haiku-*` e o `claude --resume` pede esse modelo; antes isso virava `client-model:haiku` e derrubava a sessão para `fast`. Sem estado anterior da sessão, o modelo do cliente continua decidindo o tier como antes. Consequência: `/model haiku` numa sessão `frontier` não reduz mais a sessão; para isso use `#fast` ou `x-jev-tier: fast`.
- **`effectiveTier`** é o tier em que o pedido roda (header `x-jev-tier`, modelo e effort). Num turno humano novo, com resposta válida do Jev:
  - se a categoria do Jev tem um threshold e a probabilidade alcança esse threshold, o tier dela fica abaixo do `sessionTier` e o Jev não escalou nem acionou `risk-override` ou `claim-guard`, então `effectiveTier = tier do Jev` (razão `request-downgrade`) e o `sessionTier` não muda;
  - caso contrário, `effectiveTier = max(sessionTier, tier do Jev)`, que é o comportamento de antes (`jev-keep` ou `upgrade:…`), e o `sessionTier` sobe junto.
- **Sem decisão nova do Jev, nada desce.** Chamadas de ferramenta e passos do loop de tool, pedidos de background e side, `count_tokens`, `sticky`, timeout ou falha do Jev e `fallback:keep` mantêm o comportamento atual. Timeout e falha voltam para o `sessionTier`.
- Um pedido `deep` nunca roda abaixo de `deep`, porque `deep` não tem threshold. Uma sessão `deep` pode rodar um pedido `mechanical` muito confiável em `fast`, e o `sessionTier` continua `deep`.
- Depois de um downgrade, o próximo turno é comparado de novo ao `sessionTier`. Um pedido `complex` volta a `frontier` na hora.
- A comparação é `probabilidade >= threshold`. Threshold `1.0` (100%) quer dizer "downgrade somente quando confidence = 1.0", não "nunca": o Jev pode responder 1.0. Para desligar o downgrade, use **Request downgrade = OFF** (`enabled: false`).
- Uma categoria sem threshold nunca desce. Os nomes são categorias do Jev (`jev.options`), não tiers. O router recusa iniciar se a config for inválida: chave desconhecida, `enabled` que não seja booleano ou probabilidade fora de `0..1`.
- **Ausente ou `enabled: false`:** o hard ratchet de antes, sem nenhuma mudança.

O log de rota (`event: "route"`) passa a trazer:
- `tier`: o tier efetivo;
- `session_tier`: o tier da sessão depois da decisão;
- `jev_tier`: o tier da resposta do Jev, só quando há decisão nova.

Os logs não registram o payload nem segredos. Na Live View, o caminho roxo segue o tier efetivo. O painel da decisão mostra `Jev tier / Session tier / Effective tier` e explica `request downgrade`. A lane da sessão mostra `fast · session frontier` quando os dois tiers diferem.

Testes: `tests/router-downgrade.test.mjs`.

#### Router Settings (Live View)

A Live View não tem login: abre direto e o stream `/events` conecta na hora (com a reconexão normal do `EventSource`). O botão **Router Settings** escolhe, sem restart, o **preset** de `policy.requestDowngrade` em uso. O tier da sessão nunca diminui por causa deste painel.

Requisito: `JEV_ROUTER_SETTINGS_FILE` (no `compose.yaml`: `/config/runtime/router-settings.json`, montagem `./config/runtime` gravável). Sem ele, o painel responde 404 e a Live View segue funcionando. `JEV_ROUTER_UI_TOKEN` não existe mais: se continuar no `config/env`, é ignorado.

Presets embutidos:

| Preset | Request downgrade | mechanical | routine | complex |
|---|---|---|---|---|
| `conservative` | ON | 95% | 90% | 80% |
| `balanced` (padrão) | ON | 85% | 80% | 70% |
| `aggressive` | ON | 70% | 65% | 55% |
| `hard-ratchet` | OFF | 85% | 80% | 70% |

Os embutidos podem ser editados (**Save preset**) e voltar aos valores originais (**Reset defaults**), mas não apagados. Presets próprios: **New preset** (nome de 1 a 40 caracteres `A-Z a-z 0-9 . _ -`, sem colidir com outro ignorando maiúsculas), **Save preset** e **Delete preset** (o preset em uso não pode ser apagado). Escolher um preset no menu só preenche o formulário; **Apply** o torna o preset em uso e aplica na hora. Salvar ou resetar o preset em uso também aplica na hora. **Cancel** descarta o formulário. O resumo mostra o efeito, ex.: `mechanical >= 85% -> fast`; quando `policy.accept` eleva o threshold, mostra os dois valores (`mechanical >= 70% configured · 85% effective -> fast`) e o campo ganha a nota `Effective: 85% · limited by policy.accept.fast`. Onde configurado e efetivo são iguais, nada extra aparece. Com Request downgrade OFF, o resumo diz que o downgrade está desligado e nenhum valor efetivo é mostrado.

Como funciona:
- **Arquivo:** `router-settings.json` tem só `{ "activePreset": "…", "presets": { "<id>": { "enabled": …, "thresholds": { "mechanical": …, "routine": …, "complex": … } } } }`. Sem segredos, ignorado pelo Git. O preset em uso sobrepõe `policy.requestDowngrade` de `config.json`, que nunca é gravado, no start e no `SIGHUP`. `config/env` nunca é lido nem gravado pelo painel.
- **Migração:** se o arquivo ainda não existe e há um `request-downgrade.json` (formato antigo) na mesma pasta, as regras dele viram o preset próprio `legacy`, em uso. Sem ele, o arquivo nasce com os embutidos e `balanced` em uso. O `request-downgrade.json` não é alterado nem relido depois.
- **Endpoints:** `GET` e `PATCH /_jev/admin/settings`, sem autenticação. `PATCH` recebe `{ "action": "apply" | "delete" | "reset", "preset": "…" }` ou `{ "action": "save" | "create", "preset": "…", "values": { enabled, thresholds } }`. As respostas trazem só os presets, o preset ativo, os padrões dos embutidos, a regra em uso, `acceptFloors` (tier e `policy.accept` de cada categoria) e `effectiveThresholds` (os thresholds da regra em uso depois do piso; `null` com o downgrade OFF), nunca a config inteira. Os dois últimos são derivados da config carregada a cada leitura: não vão para o arquivo e um `PATCH` que os envie é recusado (400, chave desconhecida). Respostas de erro: 400 (JSON inválido, ação ou chave desconhecida, nome inválido, threshold fora de `0..1`, `enabled` não booleano, apagar um embutido, resetar um preset próprio), 403 (`Host` ou `Origin` de fora), 404 (preset inexistente, ou sem `JEV_ROUTER_SETTINGS_FILE`), 405 (outro método), 409 (nome repetido, apagar o preset em uso, ou o arquivo mudou no disco), 413 (corpo acima de 4 KiB) e 415 (sem `Content-Type: application/json`).
- **Persistência e hot reload:** o pedido é validado, o arquivo é relido e comparado com a memória, e o novo conteúdo vai para um temporário (fsync), que é relido. Se o preset em uso mudou, o router aplica a nova regra (`server.reload`, mantendo o `sessionTier` de cada sessão) e só então o temporário é renomeado sobre o arquivo final. Se qualquer passo falhar, a regra anterior é restaurada e o temporário apagado: memória e disco nunca divergem.
- **Localidade:** as portas são publicadas só em `127.0.0.1`. Sem login, quem alcança a porta 4100 pode trocar o preset; a checagem de `Host`/`Origin` só barra páginas de outros sites no navegador. Fora de loopback, o router avisa no start.
- **Threshold efetivo:** `efetivo = max(threshold, policy.accept[tier da categoria])` (`mechanical -> fast`, `routine -> balanced`, `complex -> frontier`, conforme `jev.options`). O downgrade exige que o Jev tenha escolhido o tier sozinho (razão `jev`), e o `applyPolicy` escala um tier abaixo do seu `policy.accept` sempre que um tier mais capaz tem alguma probabilidade. Com `accept.fast = 0.85`, o `mechanical` de 70% do `aggressive` age como 85%; os valores dos presets não mudam, só a exibição. Os pisos vêm da config carregada: mudar `policy.accept` e recarregar (`SIGHUP` ou restart) muda o que o painel mostra.

Testes: `tests/router-admin.test.mjs` e `tests/router-startup.test.mjs`.

### Compatibilidade Anthropic por modelo alvo

O Claude Code monta cada pedido para o modelo que ele acredita usar, mas o router pode enviá-lo a outro modelo. Antes do upstream, `compat.mjs` (`normalizeForTarget`) recebe o target final e remove apenas os recursos que **comprovadamente** são recusados por aquele modelo. A comprovação vem de comparar o pedido que falhou com a repetição do próprio cliente que funcionou. A função não altera a entrada e é determinística.

| Modelo alvo | Condição | Removido | Preservado |
| --- | --- | --- | --- |
| `claude-sonnet-*` | `anthropic-beta` contém exatamente `per-turn-control-2026-07-01` | esse beta; `output_config` dentro de cada item de `messages[]` | `output_config` de nível superior (effort), `thinking`, `context_management`, `tools`, demais betas (em ordem) e demais campos das mensagens |
| `claude-sonnet-*` | `anthropic-beta` contém exatamente `mid-conversation-tool-changes-2026-07-01` | esse beta; blocos `tool_addition` e `tool_removal` do `content` das mensagens `role: system` | `tools` de nível superior (o mesmo array), blocos `text` e outros tipos, mensagens `user`/`assistant`, effort, `thinking`, `context_management`, demais betas |

- As duas regras são independentes e podem valer no mesmo pedido.
- Evidência da segunda regra: Claude Code 2.1.286 enviou ao `claude-sonnet-5` uma mensagem `system` com `text` e três `tool_addition`, todas do subtipo `tool_reference` para ferramentas que já estavam em `tools` (17). A API respondeu `400 tool_addition/tool_removal is not supported on this model`. A repetição do próprio cliente, sem o beta e sem os três blocos, com `tools` idêntico (mesmo hash), recebeu `200`. Só `tool_addition` foi observado. `tool_removal` é removido porque o erro o cita junto.
- Se uma mensagem `system` ficar sem nenhum bloco depois da remoção, ela é retirada inteira, porque a API não aceita `content` vazio. Uma mensagem com `content` em string ou já vazia fica como veio.
- Opus, Haiku e OpenAI não passam por nenhuma regra. No Haiku, o dobramento das mensagens `system`, que já existia no router, continua igual.
- O log `done` traz apenas flags e contagens, por exemplo `compat: { perTurnControlRemoved: true, messageOutputConfigRemoved: 1, midConversationToolChangesRemoved: true, toolAdditionBlocksRemoved: 3, toolRemovalBlocksRemoved: 0 }`. Não registra betas, nomes de ferramentas, texto nem headers.

Validação real (Claude Code 2.1.286): `routine → balanced → claude-sonnet-5` com effort `medium` recebeu `200` no **primeiro** pedido ao upstream.

### Recomendação do benchmark

`efforts.recommended` no relatório traz a combinação sugerida pronta para o router, por exemplo:

```json
{
  "provider": "openai",
  "tier": "balanced",
  "model": "gpt-6.1-sol",
  "effort": "low",
  "applied": false,
  "configPath": "surfaces.openai.balanced",
  "configPatch": { "model": "gpt-6.1-sol", "effort": "low" }
}
```

Ela **nunca é aplicada automaticamente**: para adotá-la, copie `configPatch` para o target indicado em `configPath` no seu `config.json` e reinicie o router. Quando o modelo não aceita effort (Haiku) ou nenhum effort foi enviado (`cli-default`), `effort` é `null` e `configPatch` contém só `model`.

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

Testes do router patchado (`node:test`): allowlists, reescrita do body por provider, precedência, recusa de configs inválidas, recusas do `apply.mjs` (versão errada, hash divergente), `GET /v1/models` (repasse do catálogo real, nunca vazio, token, rotas que não mudam), effort no Live View, destaque da rota no Live View (mesmas arestas do grafo para cada categoria/tier, troca de modelo e de cliente) e política do tier `deep`. A parte de integração sobe o router patchado contra um upstream falso local, sem credenciais nem chamadas reais. O jeito mais simples é rodar dentro da imagem, sem rede:

```powershell
docker run --rm --network none `
  -v "${PWD}/tests:/repo/tests:ro" `
  -v "${PWD}/patches:/repo/patches:ro" `
  -v "${PWD}/config/config.example.json:/repo/config/config.example.json:ro" `
  jev-router-jev-router node --test /repo/tests/router-effort.test.mjs
```

No host (Node 22+), `node --test tests/router-effort.test.mjs` roda os testes unitários; os de integração exigem `JEV_ROUTER_PKG` apontando para uma cópia patchada do pacote e são pulados caso contrário.

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

A identificação do projeto no Live View depende desses wrappers: chamar `claude.exe` ou `codex.exe` diretamente não envia metadata de projeto, e as requisições aparecem sem projeto. O `claude.cmd` também não injeta nada quando você passa `--settings` (ou `--settings=...`) como opção.

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
│   ├── env.example
│   └── runtime/       (Router Settings: router-settings.json, ignorado pelo Git)
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
├── patches/
│   └── jev-router-1.6.0/
│       ├── apply.mjs    (aplicado no build; falha se versão/hash divergirem)
│       ├── effort.mjs   (effort por target)
│       ├── compat.mjs   (compatibilidade Anthropic por modelo alvo)
│       ├── models.mjs   (GET /v1/models para o Codex)
│       ├── admin.mjs    (Router Settings: presets e /_jev/admin/settings)
│       ├── ui-effort.js (Live View: effort por requisição)
│       ├── ui-route.js  (Live View: arestas do grafo e da rota em foco)
│       └── ui-settings.js/.css (Live View: painel Router Settings)
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
│   ├── model-lab-effort.tests.ps1
│   └── router-effort.test.mjs
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