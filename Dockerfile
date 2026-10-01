FROM node:22-bookworm-slim

RUN npm install -g @ediri/jev-router@1.6.0

# Compatibilidade com Codex usando login ChatGPT.
# O Codex chama /v1/responses, mas o backend ChatGPT espera
# /backend-api/codex/responses.
RUN node -e "const fs=require('fs'); \
const p='/usr/local/lib/node_modules/@ediri/jev-router/src/router.mjs'; \
let s=fs.readFileSync(p,'utf8'); \
const old='const upstream = await fetch(target.url + req.url, {'; \
const neu=\"const upstreamPath = target.url.includes('chatgpt.com/backend-api/codex') ? req.url.replace(/^\\\\/v1/, '') : req.url;\\n  const upstream = await fetch(target.url + upstreamPath, {\"; \
if(!s.includes(old)) throw new Error('patch target not found'); \
s=s.replace(old,neu); \
fs.writeFileSync(p,s);"

RUN mkdir -p /config /state

EXPOSE 4000 4100

CMD ["jev-router", "serve", "--config", "/config/config.json", "--env-file", "/config/env", "--log-file", "/state/router.log", "--host", "0.0.0.0", "--port", "4000", "--ui", "0.0.0.0:4100"]