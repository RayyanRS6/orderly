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
# Shared source resolves zod from the project root during compilation. It also needs an ESM
# package scope: without one, NodeNext emits it as CommonJS, which the ESM runtime cannot import.
RUN echo '{"type":"module"}' > /app/package.json \
  && ln -s /app/gateway/node_modules /app/node_modules && npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
ENV NODE_ENV=production GATEWAY_DATA_DIR=/data GATEWAY_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/gateway/node_modules ./node_modules
COPY --from=build --chown=node:node /app/gateway/dist ./dist
COPY --from=build --chown=node:node /app/gateway/package.json ./package.json
# The entrypoint stays root-owned (the app cannot modify it). Started as node it just runs the
# CMD; started as root to fix a root-owned volume (Railway) it chowns /data, then drops to node
# with setpriv (Debian's essential util-linux; the build fails here if it is ever missing).
COPY gateway/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && command -v setpriv > /dev/null \
  && mkdir /data && chown node:node /data
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/gateway/src/index.js"]
