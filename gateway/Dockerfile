FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
WORKDIR /app/gateway
COPY gateway/package*.json ./
RUN npm ci
COPY gateway/tsconfig.json ./
COPY gateway/src ./src
COPY src/shared/whatsapp.ts /app/src/shared/whatsapp.ts
COPY server/whatsapp/signing.ts /app/server/whatsapp/signing.ts
# Shared source resolves zod from the project root during compilation.
RUN ln -s /app/gateway/node_modules /app/node_modules && npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
ENV NODE_ENV=production GATEWAY_DATA_DIR=/data GATEWAY_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/gateway/node_modules ./node_modules
COPY --from=build --chown=node:node /app/gateway/dist ./dist
COPY --from=build --chown=node:node /app/gateway/package.json ./package.json
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/gateway/src/index.js"]
