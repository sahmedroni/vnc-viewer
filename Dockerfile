# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# tsx ships in devDependencies and the app runs the TS entry directly,
# so install dev dependencies on purpose.
RUN npm ci --include=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY proxy ./proxy
COPY public ./public
COPY components ./components

# Persisted at runtime via a volume.
RUN mkdir -p /app/connections && chown -R node:node /app
USER node

EXPOSE 6080

# A plain GET on "/" serves the UI once PROXY_TOKEN is set.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "node_modules/tsx/dist/cli.mjs", "proxy/server.ts"]
