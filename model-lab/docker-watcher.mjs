import fs from "node:fs";
import path from "node:path";

const LAB = "/model-lab";
const ROUTER_CONFIG = "/config/config.json";

const STATE_FILE = path.join(LAB, "seen-models.json");
const PENDING_FILE = path.join(LAB, "pending-models.json");
const LOG_FILE = path.join(LAB, "docker-watcher.log");

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SOURCES = [
  "https://raw.githubusercontent.com/dirien/jev-router/main/config/anthropic-only.json",
  "https://raw.githubusercontent.com/dirien/jev-router/main/config/anthropic-fable.json",
  "https://raw.githubusercontent.com/dirien/jev-router/main/config/default.json",
];

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  const line = `${timestamp()}  ${message}`;

  console.log(line);

  fs.appendFileSync(
    LOG_FILE,
    `${line}\n`,
    "utf8"
  );
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8").trim();

    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    log(`ERRO lendo ${file}: ${error.message}`);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(
    file,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

function addCandidate(list, provider, tier, model) {
  if (!["fast", "balanced", "frontier"].includes(tier)) {
    return;
  }

  if (!model || typeof model !== "string") {
    return;
  }

  // Neste ambiente queremos somente modelos oficiais
  // das famílias OpenAI e Anthropic.
  if (
    provider === "openai" &&
    !model.startsWith("gpt-")
  ) {
    return;
  }

  if (
    provider === "anthropic" &&
    !model.startsWith("claude-")
  ) {
    return;
  }

  // Mantém compatibilidade com o seen-models.json
  // criado anteriormente pelo watch.ps1.
  const key = `${provider}|${model}`;

  if (!list.has(key)) {
    list.set(key, {
      provider,
      tier,
      model,
    });
  }
}

async function fetchJson(url) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    20000
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "jev-model-watcher/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverModels() {
  const discovered = new Map();

  for (const url of SOURCES) {
    try {
      const remote = await fetchJson(url);

      const anthropic = remote?.surfaces?.anthropic;

      if (anthropic) {
        for (const [tier, config] of Object.entries(anthropic)) {
          addCandidate(
            discovered,
            "anthropic",
            tier,
            config?.model
          );
        }
      }

      const openai = remote?.surfaces?.openai;

      if (openai) {
        for (const [tier, config] of Object.entries(openai)) {
          addCandidate(
            discovered,
            "openai",
            tier,
            config?.model
          );
        }
      }
    } catch (error) {
      log(
        `Falha consultando ${url}: ${error.message}`
      );
    }
  }

  return discovered;
}

function getCurrentModel(config, provider, tier) {
  try {
    return (
      config?.surfaces?.[provider]?.[tier]?.model ??
      null
    );
  } catch {
    return null;
  }
}

function readPending() {
  const value = readJson(PENDING_FILE, []);

  if (!Array.isArray(value)) {
    return value ? [value] : [];
  }

  return value.filter(Boolean);
}

function mergePending(existing, additions) {
  const result = new Map();

  for (const item of existing) {
    if (!item) {
      continue;
    }

    const key =
      `${item.provider}|${item.tier}|${item.candidate}`;

    result.set(key, item);
  }

  for (const item of additions) {
    const key =
      `${item.provider}|${item.tier}|${item.candidate}`;

    result.set(key, item);
  }

  return [...result.values()];
}

async function checkOnce() {
  log("Iniciando verificacao de modelos.");

  const current = readJson(ROUTER_CONFIG);

  if (!current) {
    log(
      "ERRO: nao foi possivel carregar /config/config.json."
    );
    return;
  }

  const discovered = await discoverModels();

  if (discovered.size === 0) {
    log(
      "Nenhum modelo foi obtido das fontes. Estado preservado."
    );
    return;
  }

  // ----------------------------------------------------------
  // Primeiro uso
  // ----------------------------------------------------------

  if (!fs.existsSync(STATE_FILE)) {
    const baseline = {
      initializedAt: timestamp(),
      seen: [...discovered.keys()].sort(),
    };

    writeJson(STATE_FILE, baseline);

    if (!fs.existsSync(PENDING_FILE)) {
      writeJson(PENDING_FILE, []);
    }

    log(
      `Baseline criado com ${discovered.size} modelos conhecidos.`
    );

    log(
      "Nenhum benchmark solicitado no primeiro uso."
    );

    return;
  }

  // ----------------------------------------------------------
  // Estado existente
  // ----------------------------------------------------------

  const state = readJson(STATE_FILE, {
    seen: [],
  });

  const seen = new Set(
    Array.isArray(state?.seen)
      ? state.seen
      : []
  );

  const newModels = [];

  for (const [key, item] of discovered.entries()) {
    if (seen.has(key)) {
      continue;
    }

    const currentModel = getCurrentModel(
      current,
      item.provider,
      item.tier
    );

    const candidate = {
      detectedAt: timestamp(),
      provider: item.provider,
      tier: item.tier,
      candidate: item.model,
      current: currentModel,
      status: "pending-benchmark",
    };

    newModels.push(candidate);

    log(
      `NOVO MODELO: ${item.provider} / ${item.model} / tier sugerido=${item.tier}`
    );
  }

  // ----------------------------------------------------------
  // Nenhuma novidade
  // ----------------------------------------------------------

  if (newModels.length === 0) {
    if (!fs.existsSync(PENDING_FILE)) {
      writeJson(PENDING_FILE, []);
    }

    log("Nenhum modelo novo detectado.");
    return;
  }

  // ----------------------------------------------------------
  // Preservar pendencias existentes + adicionar novidades
  // ----------------------------------------------------------

  const existingPending = readPending();

  const mergedPending = mergePending(
    existingPending,
    newModels
  );

  writeJson(
    PENDING_FILE,
    mergedPending
  );

  // Só depois de registrar corretamente em pending,
  // marcamos os modelos como conhecidos.
  for (const key of discovered.keys()) {
    seen.add(key);
  }

  writeJson(STATE_FILE, {
    updatedAt: timestamp(),
    seen: [...seen].sort(),
  });

  log(
    `${newModels.length} novo(s) modelo(s) aguardando benchmark.`
  );
}

async function main() {
  fs.mkdirSync(LAB, {
    recursive: true,
  });

  log("jev-model-watcher iniciado.");

  while (true) {
    try {
      await checkOnce();
    } catch (error) {
      log(
        `ERRO inesperado: ${error?.stack ?? error}`
      );
    }

    const nextCheck = new Date(
      Date.now() + CHECK_INTERVAL_MS
    );

    log(
      `Proxima verificacao: ${nextCheck.toISOString()}`
    );

    await new Promise((resolve) =>
      setTimeout(resolve, CHECK_INTERVAL_MS)
    );
  }
}

await main();