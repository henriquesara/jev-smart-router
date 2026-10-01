FROM node:22-bookworm-slim

RUN npm install -g @ediri/jev-router@1.6.0

# Patch versionado em patches/jev-router-1.6.0 (ver apply.mjs):
# - compatibilidade com Codex usando login ChatGPT (/v1/responses -> /backend-api/codex/responses);
# - effort de raciocinio por target (o router define modelo + effort).
# O script confere versao, SHA-256 dos arquivos originais e cada trecho alterado;
# qualquer divergencia falha o build.
COPY patches/jev-router-1.6.0/ /tmp/jev-patch/
RUN node /tmp/jev-patch/apply.mjs /usr/local/lib/node_modules/@ediri/jev-router \
 && rm -rf /tmp/jev-patch

RUN mkdir -p /config /state

EXPOSE 4000 4100

CMD ["jev-router", "serve", "--config", "/config/config.json", "--env-file", "/config/env", "--log-file", "/state/router.log", "--host", "0.0.0.0", "--port", "4000", "--ui", "0.0.0.0:4100"]
