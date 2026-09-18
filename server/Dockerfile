# ---- build: compile TypeScript and native better-sqlite3 ----
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace=server --include-workspace-root=false --ignore-scripts=false
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build -w server && npm prune --omit=dev --workspace=server

# ---- runtime: non-root, only dist + prod deps ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production KONCORDIA_HOST=0.0.0.0 KONCORDIA_PORT=8787 KONCORDIA_DB=/data/koncordia.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/cli.js", "http"]
