# The hosted StitchBench / StitchShop image: the same app Railway builds, for any Docker host.
#   docker build -t stitchbench .
# One image serves both programs: run it with APP_NAME=StitchShop and DEFAULT_SHOP_KIND=retail for StitchShop (INSTALL.md).
# Needs a Postgres 17 database: DATABASE_URL and AUTH_SECRET at run time (docker-compose.selfhost.yml has both).
# On start it runs the migrations and seeds an empty database (`npm start`), then serves on port 3000.
FROM node:25-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# openssl: Prisma; ca-certificates: outbound mail, Stripe, the hub.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/copy-pdf-worker.mjs scripts/copy-pdf-worker.mjs
RUN npm ci --no-audit --no-fund

COPY . .
# Not used while building, but Prisma's config reads it.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Run as an ordinary user; Next writes its cache under .next.
RUN chown -R node:node /app/.next
EXPOSE 3000
USER node
CMD ["npm", "start"]
