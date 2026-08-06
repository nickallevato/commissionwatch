FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
COPY knexfile.ts ./
RUN npx tsc

FROM node:22-alpine

# Build identifiers, served by GET /api/version and compared against the
# frontend's /version.json at deploy time. Declared in the FINAL stage on
# purpose: an ARG only exists in the stage that declares it, so putting it in
# the builder would leave this stage with the default and report "unknown" on
# every real build.
#
# Default "unknown" rather than a plausible value — the deploy's skew check
# needs "not stamped" to be distinguishable from "stamped".
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY knexfile.ts ./
COPY migrations/ ./migrations/
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 3001
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
